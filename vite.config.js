import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ox-quiz/', // GitHub Pages 배포를 위한 기본 저장소 경로 설정
  server: {
    host: true, // 외부 접속(모바일 등) 허용
    port: 3000  // 포트 3000 고정
  }
});

