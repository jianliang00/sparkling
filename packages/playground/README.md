# sparkling-playground

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

Demo application for testing and showcasing Sparkling framework features with integrated method modules.

## Getting Started

```bash
pnpm install
pnpm run dev
```

Edit `src/pages/` — the app hot reloads.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start development server |
| `pnpm build` | Build production bundle |
| `pnpm preview` | Preview built bundle |
| `pnpm test` | Run tests |

## Run on Device

From the repository root:

```bash
# Build Lynx bundles first (required for native app resources)
pnpm --filter sparkling-playground build

# Android
npx sparkling run:android

# iOS
npx sparkling run:ios
```
