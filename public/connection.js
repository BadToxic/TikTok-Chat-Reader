/**
 * Wrapper for client-side TikTok/Twitch connection over Socket.IO
 * With reconnect functionality.
 */
class TikTokIOConnection {
    constructor(backendUrl) {
        this.socket = io(backendUrl);
        this.uniqueId = null;
        this.options = null;
        this.platform = 'tiktok'; // Default platform

        this.socket.on('connect', () => {
            console.info("Socket connected!");
            // Reconnect to streamer if uniqueId already set
            if (this.uniqueId) {
                this.setUniqueId();
            }
        })

        this.socket.on('disconnect', () => {
            console.warn("Socket disconnected!");
        })

        this.socket.on('streamEnd', () => {
            console.warn("LIVE has ended!");
            this.uniqueId = null;
        })

        // Handle platform-specific disconnects
        this.socket.on('tiktokDisconnected', (errMsg) => {
            console.warn('TikTok disconnected:', errMsg);
            if (errMsg && errMsg.includes('LIVE has ended')) {
                this.uniqueId = null;
            }
        });

        this.socket.on('streamDisconnected', (data) => {
            console.warn('Stream disconnected:', data);
            if (data.reason && data.reason.includes('ended')) {
                this.uniqueId = null;
            }
        });

        this.socket.on('streamConnected', (data) => {
            console.info('Stream connected:', data);
        });
    }

    connect(uniqueId, options, platform = 'tiktok') {
        this.uniqueId = uniqueId;
        this.options = options || {};
        this.platform = platform;
        this.setUniqueId();
        return new Promise((resolve, reject) => {
            this.socket.once('streamConnected', resolve);
            this.socket.once('streamDisconnected', reject);
            setTimeout(() => {
                reject('Connection Timeout');
            }, 15000)
        })
    }

    setUniqueId() {
        if (this.platform === 'twitch') {
            this.socket.emit('setTwitchStreamerId', this.uniqueId, this.options);
        } else {
            this.socket.emit('setUniqueId', this.uniqueId, this.options);
        }
    }

    on(eventName, eventHandler) {
        this.socket.on(eventName, eventHandler);
    }
}
