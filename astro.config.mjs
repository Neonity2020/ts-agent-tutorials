// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  // TODO: 部署后替换为真实域名（影响 canonical / sitemap 等绝对链接）
  site: "https://example.com",
  // 托管端要求尾斜杠，否则 /04-tool-system 会回退到首页（站内链接全断）
  trailingSlash: "always",
  build: {
    format: "directory",
  },
  markdown: {
    // 中文教程里 shell / json 代码占比很高，统一双主题。
    // 深色用 github-dark（#0d1117 底 / #c9d1d9 字），对比度高于 -dimmed，
    // 且底色与站点 --bg (#0f1115) 接近。
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      wrap: true,
    },
  },
});