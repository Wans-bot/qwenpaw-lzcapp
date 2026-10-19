// 把「中转后的镜像地址 + 目标版本号」写回工程文件。
//
// 只在 CI 里跑（也可以本地跑，看 env 就知道要改什么）：
//   LPK_VERSION=2.2.2 UPSTREAM_VERSION=2.2.2 IMAGE=registry.lazycat.cloud/...:tag \
//     node pkgscript/apply-release.mjs
import fs from 'node:fs';

const IMAGE = required('IMAGE'); // copy-image 输出的完整 registry 地址
const LPK_VERSION = required('LPK_VERSION');
const UPSTREAM_VERSION = required('UPSTREAM_VERSION');
const UPSTREAM_DIGEST = process.env.UPSTREAM_DIGEST || '';
const STATE_FILE = 'upstream.json';

function required(name) {
	const value = String(process.env[name] || '').trim();
	if (!value) throw new Error(`缺少环境变量 ${name}`);
	return value;
}

function replaceSingle(file, pattern, replacement, label) {
	const source = fs.readFileSync(file, 'utf8');
	if (!pattern.test(source)) throw new Error(`${file} 里没找到 ${label}`);
	// 计数确认只命中一次，避免把别的服务/字段一起改掉
	const hits = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
	if (hits && hits.length > 1) throw new Error(`${file} 里 ${label} 命中 ${hits.length} 次，预期 1 次`);
	fs.writeFileSync(file, source.replace(pattern, replacement));
}

// 1. 镜像地址：只改 services.qwenpaw.image 这一行
replaceSingle(
	'lzc-manifest.yml',
	/^(\s{4}image:\s*).*$/m,
	`$1${IMAGE}`,
	'services.qwenpaw.image',
);

// 2. 版本号：package.yml 顶层的 version
replaceSingle('package.yml', /^version:\s*.+$/m, `version: ${LPK_VERSION}`, 'package.yml version');

// 3. 上游状态：下次运行据此判断是否已是最新
const nextState = {
	version: UPSTREAM_VERSION,
	digest: UPSTREAM_DIGEST,
	lpk_version: LPK_VERSION,
	revision: LPK_VERSION === UPSTREAM_VERSION
		? 1
		: Number(String(LPK_VERSION).slice(String(UPSTREAM_VERSION).length + 1) || 1),
	image: IMAGE,
	updated_at: new Date().toISOString(),
};
fs.writeFileSync(STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`);

// 4. 更新日志：Release 正文与商店审核都读这两份
const date = new Date().toISOString().slice(0, 10);
const zhLines = [
	`跟随上游 QwenPaw ${UPSTREAM_VERSION}。`,
	'',
	`- 镜像：${IMAGE}`,
	'- 数据目录沿用原来三处挂载，升级不丢会话与技能配置。',
];
const enLines = [
	`Synced to upstream QwenPaw ${UPSTREAM_VERSION}.`,
	'',
	`- Image: ${IMAGE}`,
	'- Data mounts are unchanged, so conversations and skills survive the upgrade.',
];

fs.mkdirSync('.github', { recursive: true });
fs.writeFileSync('.github/changelog.zh.md', `${zhLines.join('\n')}\n`);
fs.writeFileSync('.github/changelog.en.md', `${enLines.join('\n')}\n`);

// CHANGELOG.md 里追加一段（最新在最上面，紧跟标题）
const entry = `## ${LPK_VERSION} - ${date}\n\n${zhLines.join('\n')}\n\n`;
const existing = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '# CHANGELOG\n\n';
if (!existing.includes(`## ${LPK_VERSION} `)) {
	const firstHeadingEnd = existing.startsWith('# CHANGELOG')
		? existing.indexOf('\n') + 1
		: 0;
	const head = existing.slice(0, firstHeadingEnd);
	const tail = existing.slice(firstHeadingEnd).replace(/^\n+/, '');
	fs.writeFileSync('CHANGELOG.md', `${head}\n${entry}${tail}`);
}

console.log(`[apply] 镜像 → ${IMAGE}`);
console.log(`[apply] 版本 → ${LPK_VERSION}（上游 ${UPSTREAM_VERSION}）`);
