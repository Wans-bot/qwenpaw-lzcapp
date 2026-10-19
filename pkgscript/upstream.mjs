// 解析上游 QwenPaw 的最新版本，并判断是否需要出包。
//
// 版本来源优先级：
//   1. Docker Hub 上 agentscope/qwenpaw 的 tag 列表（按 semver 取最大稳定版）
//      —— 这是真正决定用户跑什么的东西，顺带能拿到 digest 用于识别「同版本重建」。
//   2. Docker Hub 不可用时退回 GitHub Releases（vX.Y.Z），再由 copy-image 阶段
//      验证镜像是否真的存在；镜像不存在会让 job 失败，不会静默发错版本。
//
// 输出走 GITHUB_OUTPUT；本地直接 `node pkgscript/upstream.mjs` 也能看结论。
import fs from 'node:fs';

const IMAGE_REPO = process.env.UPSTREAM_IMAGE_REPO || 'agentscope/qwenpaw';
// stable: 只认 X.Y.Z；beta: 允许 X.Y.Z-beta.N（预发布线，手动触发时用）
const TRACK = process.env.UPSTREAM_TRACK || 'stable';
const STATE_FILE = 'upstream.json';
const FORCE = String(process.env.FORCE || '').toLowerCase() === 'true';
const OVERRIDE = String(process.env.UPSTREAM_VERSION_OVERRIDE || '').trim();
const GH_TOKEN = process.env.GITHUB_TOKEN || '';

const STABLE_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const BETA_RE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

function parseVersion(v) {
	const s = STABLE_RE.exec(v);
	if (s) return { nums: [1, 2, 3].map((i) => Number(s[i])), pre: null };
	const b = BETA_RE.exec(v);
	if (b) return { nums: [1, 2, 3].map((i) => Number(b[i])), pre: Number(b[4]) };
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
	// 同号时：正式版 > 预发布版
	if (pa.pre === null && pb.pre === null) return 0;
	if (pa.pre === null) return 1;
	if (pb.pre === null) return -1;
	return pa.pre - pb.pre;
}

function pickCandidate(list) {
	const matched = list.filter((item) => parseVersion(item.version));
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

async function listHubTags() {
	const tags = [];
	let url = `https://hub.docker.com/v2/repositories/${IMAGE_REPO}/tags?page_size=100&ordering=last_updated`;
	for (let page = 0; url && page < 5; page += 1) {
		const res = await fetch(url, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`Docker Hub tags HTTP ${res.status}`);
		const json = await res.json();
		for (const item of json.results ?? []) {
			tags.push({ version: String(item.name ?? ''), digest: String(item.digest ?? '') });
		}
		url = json.next ?? null;
	}
	return tags;
}

async function listGithubReleases() {
	const res = await fetch('https://api.github.com/repos/agentscope-ai/QwenPaw/releases?per_page=50', {
		headers: {
			accept: 'application/vnd.github+json',
			...(GH_TOKEN ? { authorization: `token ${GH_TOKEN}` } : {}),
		},
	});
	if (!res.ok) throw new Error(`GitHub releases HTTP ${res.status}`);
	const json = await res.json();
	return json
		.filter((release) => !release.draft)
		.map((release) => ({
			version: String(release.tag_name ?? '').replace(/^v/, ''),
			digest: '',
		}));
}

function readState() {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
	} catch {
		return { version: '', digest: '' };
	}
}

function selectCandidate(list) {
	if (TRACK === 'beta') {
		return pickCandidate(list.filter((item) => BETA_RE.test(item.version)));
	}
	return pickCandidate(list.filter((item) => STABLE_RE.test(item.version)));
}

function emit(result) {
	const lines = Object.entries(result).map(([k, v]) => `${k}=${v ?? ''}`);
	const out = process.env.GITHUB_OUTPUT;
	if (out) fs.appendFileSync(out, `${lines.join('\n')}\n`);
	for (const [k, v] of Object.entries(result)) console.log(`${k}: ${v}`);
}

async function main() {
	const state = readState();

	let candidate = null;
	let source = '';
	try {
		candidate = selectCandidate(await withRetry('Docker Hub', listHubTags));
		source = 'dockerhub';
	} catch (error) {
		console.error(`[upstream] Docker Hub 不可用，退回 GitHub Releases: ${error.message}`);
	}
	if (!candidate) {
		candidate = selectCandidate(await withRetry('GitHub Releases', listGithubReleases));
		source = 'github-releases';
	}
	if (!candidate) throw new Error('没能解析出任何可用版本');

	const upstreamVersion = OVERRIDE || candidate.version;
	const digest = OVERRIDE ? '' : candidate.digest;

	const sameVersion = state.version === upstreamVersion;
	const sameDigest = !state.digest || !digest || state.digest === digest;

	let changed = !sameVersion || !sameDigest || FORCE;
	let lpkVersion = upstreamVersion;
	let reason = '';

	if (!changed) {
		reason = `上游仍是 ${upstreamVersion}（${digest ? digest.slice(0, 19) : '无 digest'}），无需出包`;
	} else if (!sameVersion) {
		reason = `上游版本 ${state.version || '(无)'} → ${upstreamVersion}（来源 ${source}）`;
	} else if (!sameDigest) {
		// 同一版本号换镜像（上游重建 tag）：出 -N 修订包，避免商店拒绝重复版本号
		const revision = Number(state.revision || 1) + 1;
		lpkVersion = `${upstreamVersion}-${revision}`;
		reason = `上游 ${upstreamVersion} 镜像内容变了（${String(state.digest).slice(0, 19)} → ${String(digest).slice(0, 19)}），出修订包 ${lpkVersion}`;
	} else {
		const revision = Number(state.revision || 1) + 1;
		lpkVersion = `${upstreamVersion}-${revision}`;
		reason = `强制重建，出修订包 ${lpkVersion}`;
	}

	emit({
		changed: changed ? 'true' : 'false',
		upstream_version: upstreamVersion,
		target_digest: digest,
		lpk_version: changed ? lpkVersion : '',
		image_ref: `${IMAGE_REPO}:${upstreamVersion}`,
		reason,
	});
}

main().catch((error) => {
	console.error(`[upstream] 失败: ${error.message}`);
	process.exit(1);
});
