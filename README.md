# 3speak Video Player

A full-stack HTML5 video player built with Video.js for the 3speak platform. Supports both legacy videos and the new embed system with MongoDB backend integration.

## Features

- **Full-stack architecture** - Node.js/Express backend + Video.js frontend
- **MongoDB integration** - Connects to 3speak MongoDB for video metadata
- **Dual video systems** - Supports legacy `videos` collection and new `embed-video` collection
- **HLS streaming** - Loads videos from IPFS gateway as HLS streams
- **Status-based placeholders** - Shows different videos based on encoding status (processing, finalizing, failed, deleted)
- **View tracking** - Automatically increments view count when video plays
- **Responsive design** - Modern UI with custom 3speak styling

## Architecture

### Backend (Node.js/Express)
- `server.js` - Express server with API endpoints
- `db.js` - MongoDB connection and query functions
- `.env` - Configuration (MongoDB URI, IPFS gateway, placeholders)

### Frontend (Video.js)
- `src/index.html` - Video player page
- `src/main.js` - Player logic and API integration
- `src/styles.css` - Custom 3speak styling
- `dist/` - Webpack build output (served by Express)

## Project Structure

```
SnapieVideoPlayer/
├── server.js            # Express server
├── db.js                # MongoDB connection module
├── .env                 # Environment configuration
├── src/
│   ├── index.html       # Main HTML file
│   ├── main.js          # Player initialization and logic
│   └── styles.css       # Custom styles
├── dist/                # Build output (served by Express)
├── webpack.config.js    # Webpack configuration
└── package.json         # Project dependencies
```

## Setup

### Prerequisites

- Node.js (v16 or higher)
- Access to 3speak MongoDB
- IPFS gateway access
- PM2 (for production deployment)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd SnapieVideoPlayer
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your actual MongoDB credentials and configuration
```

**IMPORTANT:** Never commit the `.env` file to git. It contains sensitive credentials.

4. Build the frontend:
```bash
npm run build
```

5. Start the server:
```bash
npm start
```

Server runs on http://localhost:3005 (configurable via PORT in .env)

## Usage

### Legacy Videos (videos collection)

Access via: `http://localhost:3005/watch?v=owner/permlink`

Example: `http://localhost:3005/watch?v=meno/p723so6v`

### Embed Videos (embed-video collection)

Access via: `http://localhost:3005/embed?v=owner/permlink`

Example: `http://localhost:3005/embed?v=testuser123/ma4k9uzo`

### Embed Video Status Handling

The embed system shows different videos based on status:
- **uploading/encoding** → Processing placeholder video
- **finalizing** → Finalizing placeholder video
- **published** → Actual video from MongoDB
- **failed** → Failed placeholder video
- **deleted** → Deleted placeholder video

## API Endpoints

### GET /api/watch?v=owner/permlink
Returns legacy video metadata and IPFS URL

### GET /api/embed?v=owner/permlink
Returns embed video metadata with status-based URL selection

### POST /api/view
Increments view count
```json
{
  "owner": "meno",
  "permlink": "p723so6v",
  "type": "legacy" // or "embed"
}
```

## Deployment to VPS

### Step 1: Prepare the VPS

1. SSH into your VPS:
```bash
ssh user@video.3speak.tv
```

2. Install Node.js (if not already installed):
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

3. Install PM2 globally:
```bash
sudo npm install -g pm2
```

### Step 2: Deploy the Application

1. Clone the repository on the VPS:
```bash
cd /var/www  # or your preferred directory
git clone <repository-url> SnapieVideoPlayer
cd SnapieVideoPlayer
```

2. Install dependencies:
```bash
npm install --production
```

3. Create and configure `.env` file:
```bash
cp .env.example .env
nano .env  # Edit with production values
```

**Production .env settings:**
- Set `NODE_ENV=production`
- Use production MongoDB credentials
- Set `PORT=3005` (or available port)
- Update `ALLOWED_ORIGINS` to include your domain

4. Build the frontend:
```bash
npm run build
```

5. Start with PM2:
```bash
pm2 start server.js --name "3speak-player"
pm2 startup  # Enable auto-start on reboot
pm2 save
```

6. Check status:
```bash
pm2 status
pm2 logs 3speak-player
```

### Step 3: Configure Nginx Reverse Proxy

1. Create Nginx configuration:
```bash
sudo nano /etc/nginx/sites-available/play.3speak.tv
```

2. Add this configuration:
```nginx
server {
    listen 80;
    server_name play.3speak.tv;

    # Increase timeout for video streaming
    proxy_read_timeout 300;
    proxy_connect_timeout 300;
    proxy_send_timeout 300;

    location / {
        proxy_pass http://localhost:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

3. Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/play.3speak.tv /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

4. (Optional) Set up SSL with Let's Encrypt:
```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d play.3speak.tv
```

### Step 4: Verify Deployment

1. Check the application:
```bash
pm2 logs 3speak-player
```

2. Test endpoints:
```bash
curl http://localhost:3005/api/watch?v=meno/p723so6v
```

3. Visit in browser:
- http://play.3speak.tv/watch?v=meno/p723so6v
- http://play.3speak.tv/embed?v=testuser123/ma4k9uzo

## Security Checklist

Before deploying or pushing to git:

- ✅ `.env` file is in `.gitignore` and will NOT be committed
- ✅ `.env.example` provides template without sensitive data
- ✅ All credentials use environment variables (no hardcoded secrets)
- ✅ MongoDB credentials stored only in `.env`
- ✅ `dist/` and `node_modules/` excluded from git

**Files that contain sensitive info (already in .gitignore):**
- `.env` - MongoDB credentials, API keys
- `node_modules/` - Dependencies
- `dist/` - Build output

## Configuration

All configuration is in `.env`:

- `MONGODB_URI` - MongoDB connection string
- `MONGODB_DATABASE` - Database name (threespeak)
- `MONGODB_COLLECTION_LEGACY` - Legacy videos collection (videos)
- `MONGODB_COLLECTION_NEW` - Embed videos collection (embed-video)
- `IPFS_GATEWAY` - IPFS gateway URL
- `PLACEHOLDER_*_CID` - Status placeholder video CIDs
- `PORT` - Server port (default: 3005)
- `NODE_ENV` - Environment (development/production)

## Development Notes

- HLS streams loaded from IPFS gateway
- View counter increments on first play
- Player events logged to console for debugging
- Supports all Video.js features and plugins

## License

MIT
