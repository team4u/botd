import type {
  ResourceLoader,
  RegisteredCommand,
  ExtensionCommandContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';

export function guardExtensionCommands(
  loader: ResourceLoader,
  onUnsupported: (error: Error) => void,
): void {
  const wrappedCommands = new WeakSet<RegisteredCommand>();
  const { extensions } = loader.getExtensions();
  for (const ext of extensions) {
    for (const command of ext.commands.values()) {
      if (wrappedCommands.has(command)) continue;
      wrappedCommands.add(command);

      const originalHandler = command.handler;
      command.handler = async (args: string, ctx: ExtensionCommandContext) => {
        const reject = (method: PropertyKey): never => {
          const error = new Error(`此命令需要终端界面，当前网页不支持: ui.${String(method)}`);
          onUnsupported(error);
          throw error;
        };

        const ui = new Proxy(ctx.ui as ExtensionUIContext, {
          get(target, key, receiver) {
            if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
            if (key === 'theme') return reject(key);
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function' ? () => reject(key) : reject(key);
          },
        });

        const context = new Proxy(ctx, {
          get(target, key, receiver) {
            return key === 'ui' ? ui : Reflect.get(target, key, receiver);
          },
        });

        await originalHandler(args, context);
      };
    }
  }
}
