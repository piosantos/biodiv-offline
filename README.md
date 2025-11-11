# Offline Pack v2.3

## Development

### Run tests

Install dependencies (requires Node.js) and execute the automated test suite:

```bash
npm install
npm test
```

The Vitest suite currently checks that label sanitisation escapes HTML special characters and leaves benign values untouched.
# Offline Pack v4

Current release identifier: `biodiversity-offline-v4` (matches the service worker cache version).

> Note: When updating the cache identifier in `sw.js`, refresh this README entry so the release notes stay aligned.
