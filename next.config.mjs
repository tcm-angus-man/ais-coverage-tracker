/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["pg"],
  },
  eslint: {
    // ESLint errors are caught by `npm run lint` in CI — don't fail the build
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
