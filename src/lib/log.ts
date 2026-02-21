export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

export function logError(...args: unknown[]): void {
  console.error(new Date().toISOString(), "[ERROR]", ...args);
}

export function logWarn(...args: unknown[]): void {
  console.warn(new Date().toISOString(), "[WARN]", ...args);
}
