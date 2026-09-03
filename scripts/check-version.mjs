// 校验脚本头部 @version 与 README 版本徽章一致，避免发布资产与文档脱节
import fs from 'node:fs';

const script = fs.readFileSync('gitee-ai-workbench.user.js', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

const scriptVersion = (script.match(/@version\s+(\S+)/) || [])[1];
const badgeVersion = (readme.match(/版本-v([\d.]+)-green/) || [])[1];

if (!scriptVersion) {
    console.error('未在 gitee-ai-workbench.user.js 头部找到 @version');
    process.exit(1);
}
if (!badgeVersion) {
    console.error('未在 README.md 找到版本徽章（版本-vX.Y.Z-green）');
    process.exit(1);
}
if (scriptVersion !== badgeVersion) {
    console.error(`版本不一致：脚本 @version=${scriptVersion}，README 徽章=v${badgeVersion}`);
    process.exit(1);
}
console.log(`version check OK: ${scriptVersion}`);
