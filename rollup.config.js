import typescript from '@rollup/plugin-typescript';
import { defineConfig } from 'rollup';

export default defineConfig([
  {
    input: `src/index.ts`,
    output: [
      {
        file: `dist/cjs/index.js`,
        format: 'cjs',
      },
      {
        file: `dist/esm/index.js`,
        format: 'esm',
      },
    ],
    plugins: [typescript()],
  },
]);
