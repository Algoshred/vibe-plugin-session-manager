# @vibecontrols/vibe-plugin-session-manager

<!-- VIBECONTROLS_OSS_BODY_START -->

> Unified session manager — capability discovery, feature negotiation, and provider routing across tmux, WezTerm, and Zellij.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-session-manager
```

Or install the npm package directly into an existing project that hosts the VibeControls agent:

```bash
bun add @vibecontrols/vibe-plugin-session-manager
# or
npm install @vibecontrols/vibe-plugin-session-manager
```

## How it works

Session **providers** implement the persistent-terminal contract from `@vibecontrols/vibe-plugin-session-manager` (meta). The meta plugin handles capability discovery, feature negotiation and per-session routing.

This is a **meta** plugin — it owns a contract that one or more provider plugins implement. Install at least one matching provider alongside this package.

## More

- npm: <https://www.npmjs.com/package/@vibecontrols/vibe-plugin-session-manager>
- Source: <https://github.com/algoshred/vibe-plugin-session-manager>
- Plugin contract / SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- Plugin catalogue: <https://vibecontrols.com/plugins/session-manager>

<!-- VIBECONTROLS_OSS_BODY_END -->

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
