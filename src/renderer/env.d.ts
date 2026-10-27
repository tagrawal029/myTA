import type { MytaApi } from '../preload/index';

declare global {
  interface Window {
    myta: MytaApi;
  }
}

export {};
