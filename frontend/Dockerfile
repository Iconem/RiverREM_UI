# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# Empty = same origin (nginx below proxies the API on the same host).
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
# Git commit hash burned into the build (shown in the footer). Pass at build time:
#   docker build --build-arg VITE_GIT_SHA=$(git rev-parse --short HEAD) ...
ARG VITE_GIT_SHA="dev"
ENV VITE_GIT_SHA=$VITE_GIT_SHA
RUN npm run build

# ---- runtime: tiny nginx serving the static build + proxying the API ----
FROM nginx:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
