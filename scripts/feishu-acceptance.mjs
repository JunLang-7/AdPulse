#!/usr/bin/env node
// 飞书真机联调自检入口。实现位于 scripts/acceptance/，本文件只做兼容转发：
// 参数、输出格式与退出码与 #21 落地时一致。
import { main } from "./acceptance/cli.mjs";

process.exitCode = await main(process.argv.slice(2), process.env);
