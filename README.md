# MacAI

AI-powered search assistant using Cerebras LLM and SearXNG.

## Quick Start (Docker)

Run both the Node server and SearXNG together:

```bash
# Create a .env file with your API key
echo "CEREBRAS_API_KEY=your-key-here" > .env

# Start everything
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

Inside Docker Compose the Node server reaches SearXNG via `http://searxng:8080`
(the Docker service name and internal port). This is set automatically by
`docker-compose.yml`.

## Running the Node Server on the Host

If you prefer to run the Node server directly on your machine while SearXNG
stays in Docker:

```bash
# Start only SearXNG
docker compose up -d searxng

# Install dependencies and start the server
npm install
npm start
```

When running on the host, the default `SEARXNG_URL` is `http://localhost:8888`,
which maps to the container's port 8080 via the published Docker port.

## Environment Variables

| Variable           | Default                  | Description                     |
| ------------------ | ------------------------ | ------------------------------- |
| `CEREBRAS_API_KEY` | *(required)*             | API key for Cerebras            |
| `SEARXNG_URL`      | `http://localhost:8888`  | SearXNG base URL                |
| `PORT`             | `3000`                   | Port for the Express server     |
