import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Корень для трассировки файлов — наш проект (в системе есть и другие
  // lockfile, иначе Next выбирает неверный корень).
  outputFileTracingRoot: path.resolve(__dirname),
};

export default nextConfig;
