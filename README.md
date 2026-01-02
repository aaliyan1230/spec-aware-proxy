# Spec-Aware Proxy

A zero-setup, disposable API request builder that relays requests through a Cloudflare Worker.

Core properties:
- No auth, no database, no cookies
- State lives in the URL
- Optional OpenAPI spec URL for a spec-aware request form

## Local dev

```sh
npm install
npm run dev
```

## Deploy to Cloudflare Workers

One time:

```sh
npx wrangler login
```

Deploy:

```sh
npm run deploy
```

## Notes

- The relay endpoint blocks localhost and private IP ranges.
- Tokens you paste are not stored, they are only forwarded.
