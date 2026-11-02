/**
 * 回合重依赖的懒加载：pi-coding-agent / pi-ai 全家在 daemon 启动时不必加载，
 * 首个回合开始才 import，并用 Promise memoization 保证只加载一次。
 */

export interface TurnDeps {
  piAgent: typeof import('@earendil-works/pi-coding-agent');
  piAiCompat: typeof import('@earendil-works/pi-ai/compat');
  commandsMod: typeof import('../commands.js');
  webCommandUiMod: typeof import('../web-command-ui.js');
}

let turnDepsPromise: Promise<TurnDeps> | undefined;

export function loadTurnDeps(): Promise<TurnDeps> {
  return (turnDepsPromise ??= Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai/compat'),
    import('../commands.js'),
    import('../web-command-ui.js'),
  ]).then(([piAgent, piAiCompat, commandsMod, webCommandUiMod]) => ({
    piAgent,
    piAiCompat,
    commandsMod,
    webCommandUiMod,
  })));
}
