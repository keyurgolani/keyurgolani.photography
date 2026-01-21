# Docker Deployment Instructions

This React application is containerized and ready for deployment. Here's how to use it:

## Development

```bash
# Start development server
npm run dev
```

## Production Build & Deployment

1. Build the Docker image:
```bash
docker-compose build
```

2. Run the container:
```bash
docker-compose up -d
```

The application will be available at http://localhost:80

## Configuration

- The application uses Nginx as the web server in production
- Production builds are optimized with:
  - Code minification
  - Chunk splitting
  - Asset optimization
  - Production Node environment
- Security headers are configured in nginx.conf

## Environment Variables

Create a `.env` file if needed for environment-specific configurations.

## Stopping the Service

```bash
docker-compose down
```