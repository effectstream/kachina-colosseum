const custom = Symbol.for('nodejs.util.inspect.custom');

function inspect(value, options) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && value !== null && custom in value) {
    const fn = value[custom];
    if (typeof fn === 'function') return fn.call(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

inspect.custom = custom;

module.exports = inspect;
