# Offline Pack v2.3

## Development

### Run tests

Install dependencies (requires Node.js) and execute the automated test suite:

```bash
npm install
npm test
```

The Vitest suite currently checks that label sanitisation escapes HTML special characters and leaves benign values untouched.
