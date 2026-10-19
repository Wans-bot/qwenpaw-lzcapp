// 解析上游 QwenPaw 的最新版本，确认对应镜像真实存在，并判断是否需要出包。
//
// 上游约定（见 agentscope-ai/QwenPaw 的 .github/workflows/release.yml）：
//   发布 tag 是 vX.Y.Z，镜像同时推 Docker Hub 与阿里云 ACR，Docker Hub 上的
//   tag 也带 v 前缀（agentscope/qwenpaw:v2.2.2），另外还有 latest / pre。
//   仓库里的 docker-compose.yml 用的是 :latest，但版本化 tag 才是可复现的锚点。
//
// 因此版本号取自 GitHub Releases（有 changelog），镜像 tag 用 vX.Y.Z，
// 但**不假设**它一定存在——逐条去 registry 探活，拿 Docker-Content-Digest
// 做「同版本换镜像」的识别；版本 tag 缺失时才退回 :latest。
//
// 输出走 GITHUB_OUTPUT；本地直接 `node pkgscript/upstream.mjs` 也能看结论。
import fs from 'node:fs';

const IMAGE_REPO = process.env.UPSTREAM_IMAGE_REPO || 'agentscope/qwenpaw';
// stable: 只认 X.Y.Z / X.Y.Z.postN；beta: 额外允许 X.Y.Z-beta.N
const TRACK = process.env.UPSTREAM_TRACK || 'stable';
const STATE_FILE = 'upstream.json';
const FORCE = String(process.env.FORCE || '').toLowerCase() === 'true';
const OVERRIDE = String(process.env.UPSTREAM_VERSION_OVERRIDE || '').trim().replace(/^v/, '');
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const UPSTREAM_REPO = process.env.UPSTREAM_REPO || 'agentscope-ai/QwenPaw';

const CORE_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const POST_RE = /^(\d+)\.(\d+)\.(\d+)\.post(\d+)$/;
const BETA_RE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

function parseVersion(v) {
	const core = CORE_RE.exec(v);
	if (core) return { nums: [1, 2, 3].map((i) => Number(core[i])), pre: null, post: 0 };
	const post = POST_RE.exec(v);
	if (post) return { nums: [1, 2, 3].map((i) => Number(post[i])), pre: null, post: Number(post[4]) };
	const beta = BETA_RE.exec(v);
	if (beta) return { nums: [1, 2, 3].map((i) => Number(beta[i])), pre: Number(beta[4]), post: 0 };
	return null;
}

function cmpVersion(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa) return -1;
	if (!pb) return 1;
	for (let i = 0; i < 3; i += 1) {
		if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
	}
	// 同号：正式版 > post > 预发布
	if (pa.pre === null && pb.pre === null) return pa.post - pb.post;
	if (pa.pre === null) return 1;
	if (pb.pre === null) return -1;
	return pa.pre - pb.pre;
}

function selectCandidate(list) {
	const matched = list.filter((item) => {
		if (!parseVersion(item.version)) return false;
		return TRACK === 'beta' || BETA_RE.test(item.version) === false;
	});
	if (matched.length === 0) return null;
	matched.sort((a, b) => cmpVersion(a.version, b.version));
	return matched[matched.length - 1];
}

async function withRetry(label, fn, attempts = 3) {
	let lastError;
	for (let i = 1; i <= attempts; i += 1) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			console.error(`[upstream] ${label} 第 ${i}/${attempts} 次失败: ${error.message}`);
			if (i < attempts) await new Promise((r) => setTimeout(r, i * 3000));
		}
	}
	throw lastError;
}

async function listGithubReleases() {
	const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=100`, {
		headers: {
			accept: 'application/vnd.github+json',
			...(GH_TOKEN ? { authorization: `token ${GH_TOKEN}` } : {}),
		},
	});
	if (!res.ok) throw new Error(`GitHub releases HTTP ${res.status}`);
	const json = await res.json();
	return json
		.filter((release) => !release.draft && !release.prerelease)
		.map((release) => ({ version: String(release.tag_name ?? '').replace(/^v/, '') }));
}

// 用 Docker Hub registry v2 接口探活：HEAD manifest 拿状态码与 digest。
async function hubManifest(repoPath, tag) {
	const tokenRes = await fetch(
		`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repoPath}:pull`,
	);
	if (!tokenRes.ok) throw new Error(`Docker Hub token HTTP ${tokenRes.status}`);
	const { token } = await tokenRes.json();
	const res = await fetch(`https://registry-1.docker.io/v2/${repoPath}/manifests/${tag}`, {
		method: 'HEAD',
		headers: {
			authorization: `Bearer ${token}`,
			accept: [
				'application/vnd.oci.image.index.v1+json',
				'application/vnd.docker.distribution.manifest.list.v2+json',
				'application/vnd.oci.image.manifest.v1+json',
				'application/vnd.docker.distribution.manifest.v2+json',
			].join(','),
		},
	});
	return { ok: res.ok, status: res.status, digest: res.headers.get('docker-content-digest') || '' };
}

// 依次尝试 vX.Y.Z / X.Y.Z / latest，返回第一个真实存在的引用。
async function resolveImage(version) {
	const [repoPath] = [IMAGE_REPO];
	const candidates = [`v${version}`, version, 'latest'];
	for (const tag of candidates) {
		const probe = await withRetry(`镜像探活 ${IMAGE_REPO}:${tag}`, () => hubManifest(repoPath, tag));
		if (probe.ok) {
			return { tag, ref: `${IMAGE_REPO}:${tag}`, digest: probe.digest, pinned: tag !== 'latest' };
		}
		console.error(`[upstream] ${IMAGE_REPO}:${tag} 不可用（HTTP ${probe.status}）`);
	}
	throw new Error(`上游 ${version} 没有可用的镜像 tag（已试 ${candidates.join(', ')}）`);
}

// 商店/打包用的版本号必须是合法 semver：把 X.Y.Z.postN 映射成 X.Y.Z-post.N
function toLpkVersion(version) {
	const post = POST_RE.exec(version);
	if (post) return `${post[1]}.${post[2]}.${post[3]}-post.${post[4]}`;
	return version;
}

function readState() {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
	} catch {
		return { version: '', digest: '', revision: 1, image_tag: '' };
	}
}

function emit(result) {
	const lines = Object.entries(result).map(([k, v]) => `${k}=${v ?? ''}`);
	const out = process.env.GITHUB_OUTPUT;
	if (out) fs.appendFileSync(out, `${lines.join('\n')}\n`);
	for (const [k, v] of Object.entries(result)) console.log(`${k}: ${v}`);
}

async function main() {
	const state = readState();

	let upstreamVersion = OVERRIDE;
	let source = 'override';
	if (!upstreamVersion) {
		const candidate = selectCandidate(await withRetry('GitHub Releases', listGithubReleases));
		if (!candidate) throw new Error('没能从 GitHub Releases 解析出任何可用版本');
		upstreamVersion = candidate.version;
		source = 'github-releases';
	}

	const image = await resolveImage(upstreamVersion);

	const sameVersion = state.version === upstreamVersion;
	const sameDigest = !state.digest || !image.digest || state.digest === image.digest;
	const baseLpk = toLpkVersion(upstreamVersion);

	let changed = !sameVersion || !sameDigest || FORCE;
	let lpkVersion = baseLpk;
	let revision = 1;
	let reason = '';

	if (!changed) {
		reason = `上游仍是 ${upstreamVersion}（${image.digest ? image.digest.slice(0, 19) : '无 digest'}），无需出包`;
	} else if (!sameVersion) {
		reason = `上游版本 ${state.version || '(无)'} → ${upstreamVersion}（来源 ${source}，镜像 ${image.ref}）`;
	} else {
		// 同一版本号换了镜像（上游重建 tag）或强制重建：出 -N 修订包，避免商店拒绝重复版本号
		revision = Number(state.revision || 1) + 1;
		lpkVersion = `${baseLpk}-${revision}`;
		reason = sameDigest
			? `强制重建，出修订包 ${lpkVersion}`
			: `上游 ${upstreamVersion} 镜像内容变了（${String(state.digest).slice(0, 19)} → ${String(image.digest).slice(0, 19)}），出修订包 ${lpkVersion}`;
	}

	emit({
		changed: changed ? 'true' : 'false',
		upstream_version: upstreamVersion,
		target_digest: image.digest,
		image_ref: image.ref,
		image_tag: image.tag,
		image_pinned: image.pinned ? 'true' : 'false',
		lpk_version: changed ? lpkVersion : '',
		revision: changed ? String(revision) : '',
		reason,
	});
}

main().catch((error) => {
	console.error(`[upstream] 失败: ${error.message}`);
	process.exit(1);
});
