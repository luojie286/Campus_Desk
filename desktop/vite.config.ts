import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api 代理到本机服务，浏览器不需要额外的 CORS 配置。
export default defineConfig({
  plugins:[react()],
  server:{
    port:5173,
    proxy:{
      '/api':{
        target:'http://127.0.0.1:9087',
        changeOrigin:true,
        rewrite:path=>path.replace(/^\/api/,'')
      }
    }
  }
});
