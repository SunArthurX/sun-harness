export const defaults = { verbose: false, pageSize: 25 };
export const checks = { verbose: value => typeof value === 'boolean', pageSize: value => Number.isInteger(value) && value >= 10 && value <= 100 };
