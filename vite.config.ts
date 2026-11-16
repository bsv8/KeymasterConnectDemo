import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { keymasterPublisher } from "keymaster-app-publisher";

// 发布身份只由构建进程读取；同一私钥同时签署 URL 来源和 Files 整包。
// 本地链接与宿主使用同版 Vite，但各自 Rollup 类型来自独立安装，在插件边界统一类型。
export default defineConfig({
  plugins: [keymasterPublisher({
    mode: "both",
    name: "Keymaster Connect Demo",
    description: "验证 Connect 身份、签名、加密与存储",
    icon: "favicon.svg",
    keyFile: join(homedir(), ".config/keymaster-connect-demo/app.key.json"),
    url: "https://mimi.degu-danio.ts.net:8089/",
  }) as Plugin],
});
