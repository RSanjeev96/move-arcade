/** Beat analysis off the main thread, so songs can be prepared while a workout is running. */
import { analyze } from '../../core/beat';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ channels: Float32Array[]; sr: number }>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const a = analyze(e.data.channels, e.data.sr);
  scope.postMessage(a, [a.env.buffer]);
};
