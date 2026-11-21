# WatchParty

## Run
    npm install
    npm start
Open http://localhost:3000 in two browser windows, enter the same room code, paste a video URL
(.mp4 or HLS .m3u8) and click "Load for all". Play/pause/seek syncs across everyone.

Or pick "Use local file" on each device if everyone has the same movie file.

## Test across the internet
    npx cloudflared tunnel --url http://localhost:3000
Share the printed https URL with friends.

## Notes
- Only use videos you have rights to. Remote URLs must allow CORS/hotlinking.
- Sync: server holds {playing, position, updatedAt}; clients correct clock offset and drift.
