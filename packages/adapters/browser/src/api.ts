/** A small WebExtension facade: native browser promises, Chrome callbacks, stable native receivers. */
type Host = { browser?: typeof chrome; chrome?: typeof chrome };
const asyncMethods: Record<string, Set<string>> = {
  permissions: new Set(['contains', 'request', 'remove', 'getAll']), tabs: new Set(['query', 'create', 'update', 'remove']),
  runtime: new Set(['sendMessage', 'openOptionsPage']), scripting: new Set(['executeScript']),
  contextMenus: new Set(['removeAll', 'create']), action: new Set(['setBadgeText', 'setBadgeBackgroundColor']),
};
export function makeExtensionApi(host: Host): typeof chrome | null {
  const native = host.browser ?? host.chrome; if (!native) return null;
  const promiseApi = Boolean(host.browser), groups = new Map<PropertyKey, unknown>();
  return new Proxy(native, { get(target, group) {
    if (!asyncMethods[String(group)]) { const value = Reflect.get(target, group); return typeof value === 'function' ? value.bind(target) : value; }
    if (groups.has(group)) return groups.get(group);
    const owner = Reflect.get(target, group); if (!owner) return undefined;
    const wrapped = new Proxy(owner, { get(object, name) {
      const value = Reflect.get(object, name); if (typeof value !== 'function') return value;
      if (!asyncMethods[String(group)]!.has(String(name))) return value.bind(object);
      return (...args: unknown[]) => {
        const current = Reflect.get(object, name); if (promiseApi) { try { return Promise.resolve(Reflect.apply(current, object, args)); } catch (cause) { return Promise.reject(cause); } }
        return new Promise((resolve, reject) => {
          const callback = (...values: unknown[]) => { const error = native.runtime?.lastError; if (error) reject(new Error(error.message ?? '浏览器扩展操作失败。')); else resolve(values.length > 1 ? values : values[0]); };
          try { const result: unknown = Reflect.apply(current, object, [...args, callback]); if (result && typeof (result as PromiseLike<unknown>).then === 'function') Promise.resolve(result).then(resolve, reject); } catch (cause) { reject(cause); }
        });
      };
    } }); groups.set(group, wrapped); return wrapped;
  } });
}
