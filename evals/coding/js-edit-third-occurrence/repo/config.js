export const environments = {
  development: {
    url: 'http://localhost:3000',
    retries: 3,
    timeoutMs: 1000,
  },
  staging: {
    url: 'https://staging.example.com',
    retries: 3,
    timeoutMs: 1000,
  },
  production: {
    url: 'https://example.com',
    retries: 3,
    timeoutMs: 1000,
  },
};
