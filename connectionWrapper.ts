import { WebcastPushConnection } from 'tiktok-live-connector';
import { EventEmitter } from 'events';

let globalConnectionCount = 0;

export class TikTokConnectionWrapper extends EventEmitter {
    uniqueId: string;
    enableLog: boolean;
    clientDisconnected: boolean;
    reconnectEnabled: boolean;
    reconnectCount: number;
    reconnectWaitMs: number;
    maxReconnectAttempts: number;
    connection: WebcastPushConnection;

    constructor(uniqueId: string, options: any, enableLog: boolean) {
        super();

        this.uniqueId = uniqueId;
        this.enableLog = enableLog;

        this.clientDisconnected = false;
        this.reconnectEnabled = true;
        this.reconnectCount = 0;
        this.reconnectWaitMs = 1000;
        this.maxReconnectAttempts = 5;

        this.connection = new WebcastPushConnection(uniqueId, options);

        this.connection.on('streamEnd', () => {
            this.log(`streamEnd event received, giving up connection`);
            this.reconnectEnabled = false;
        });

        this.connection.on('disconnected', () => {
            globalConnectionCount -= 1;
            this.log(`TikTok connection disconnected`);
            this.scheduleReconnect();
        });

        this.connection.on('error', (err: any) => {
            this.log(`Error event triggered: ${err.info}, ${err.exception}`);
            console.error(err);
        });
    }

    connect(isReconnect?: boolean): void {
        this.connection.connect().then((state: any) => {
            this.log(`${isReconnect ? 'Reconnected' : 'Connected'} to roomId ${state.roomId}, websocket: ${state.upgradedToWebsocket}`);

            globalConnectionCount += 1;

            this.reconnectCount = 0;
            this.reconnectWaitMs = 1000;

            if (this.clientDisconnected) {
                this.connection.disconnect();
                return;
            }

            if (!isReconnect) {
                this.emit('connected', state);
            }

        }).catch((err: any) => {
            this.log(`${isReconnect ? 'Reconnect' : 'Connection'} failed, ${err}`);

            if (isReconnect) {
                this.scheduleReconnect(err);
            } else {
                this.emit('disconnected', err.toString());
            }
        });
    }

    scheduleReconnect(reason?: any): void {
        if (!this.reconnectEnabled) {
            return;
        }

        if (this.reconnectCount >= this.maxReconnectAttempts) {
            this.log(`Give up connection, max reconnect attempts exceeded`);
            this.emit('disconnected', `Connection lost. ${reason}`);
            return;
        }

        this.log(`Try reconnect in ${this.reconnectWaitMs}ms`);

        setTimeout(() => {
            if (!this.reconnectEnabled || this.reconnectCount >= this.maxReconnectAttempts) {
                return;
            }

            this.reconnectCount += 1;
            this.reconnectWaitMs *= 2;
            this.connect(true);

        }, this.reconnectWaitMs);
    }

    disconnect(): void {
        this.log(`Client connection disconnected`);

        this.clientDisconnected = true;
        this.reconnectEnabled = false;

        if ((this.connection as any).getState().isConnected) {
            this.connection.disconnect();
        }
    }

    log(logString: string): void {
        if (this.enableLog) {
            console.log(`WRAPPER @${this.uniqueId}: ${logString}`);
        }
    }
}

export function getGlobalConnectionCount(): number {
    return globalConnectionCount;
}