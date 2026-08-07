# Dev/build environment for PointStream3D.
# All package installation and execution happen inside this container.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching. `npm ci` installs exactly
# what package-lock.json pins, so the container matches CI.
COPY package.json package-lock.json ./
RUN npm ci

# App source is bind-mounted at runtime via docker-compose (for hot reload),
# but we also copy it so the image is self-contained for one-off runs.
COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
