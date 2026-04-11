import { WatchManager } from '../watch/watchManager';

export function createStartWatchCommand(watchManager: WatchManager): () => Promise<void> {
    return () => watchManager.start();
}

export function createStopWatchCommand(watchManager: WatchManager): () => void {
    return () => watchManager.stop();
}
