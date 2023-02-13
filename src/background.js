import browser from 'webextension-polyfill';
import {
  validateEvent,
  signEvent,
  getEventHash,
  getPublicKey
} from 'nostr-tools';
import { encrypt, decrypt } from 'nostr-tools/nip04';

import * as Storage from './storage';
import { PERMISSIONS_REQUIRED, readPermissionLevel } from './common';

const prompts = {};

browser.runtime.onMessage.addListener(async (req, sender) => {
  let { prompt } = req;

  if (prompt) {
    return handlePromptMessage(req, sender);
  } else {
    return handleContentScriptMessage(req);
  }
});

browser.runtime.onMessageExternal.addListener(
  async ({ type, params }, sender) => {
    let extensionId = new URL(sender.url).host;
    handleContentScriptMessage({ type, params, host: extensionId });
  }
);

async function handleContentScriptMessage({ type, params, host }) {
  let level = await readPermissionLevel(host);

  if (level >= PERMISSIONS_REQUIRED[type]) {
    // authorized, proceed
  } else {
    // ask for authorization
    try {
      await promptPermission(host, PERMISSIONS_REQUIRED[type], params);
      // authorized, proceed
    } catch (_) {
      // not authorized, stop here
      return {
        error: `insufficient permissions, required ${PERMISSIONS_REQUIRED[type]}`
      };
    }
  }

  let privateKey = await Storage.readPrivateKey();
  if (!privateKey) {
    return { error: 'no private key found' };
  }

  let sk = privateKey;

  try {
    switch (type) {
      case 'getPublicKey': {
        return getPublicKey(sk);
      }
      case 'getRelays': {
        let relays = await Storage.readRelays();
        return relays || {};
      }
      case 'signEvent': {
        let { event } = params;

        if (!event.pubkey) event.pubkey = getPublicKey(sk);
        if (!event.id) event.id = getEventHash(event);

        if (!validateEvent(event)) return { error: 'invalid event' };

        event.sig = await signEvent(event, sk);
        return event;
      }
      case 'nip04.encrypt': {
        let { peer, plaintext } = params;
        return encrypt(sk, peer, plaintext);
      }
      case 'nip04.decrypt': {
        let { peer, ciphertext } = params;
        return decrypt(sk, peer, ciphertext);
      }
    }
  } catch (error) {
    return { error: { message: error.message, stack: error.stack } };
  }
}

function handlePromptMessage({ id, condition, host, level }, sender) {
  switch (condition) {
    case 'forever':
    case 'expirable':
      prompts[id]?.resolve?.();
      Storage.updatePermission(host, {
        level,
        condition
      });
      break;
    case 'single':
      prompts[id]?.resolve?.();
      break;
    case 'no':
      prompts[id]?.reject?.();
      break;
  }

  delete prompts[id];
  if (browser.windows && browser.windows.remove) {
    browser.windows.remove(sender.tab.windowId);
  } else {
    browser.tabs.remove(sender.tab.tabId);
  }
}

function promptPermission(host, level, params) {
  let id = Math.random().toString().slice(4);
  let qs = new URLSearchParams({
    host,
    level,
    id,
    params: JSON.stringify(params)
  });

  return new Promise((resolve, reject) => {
    const url = `${browser.runtime.getURL('prompt.html')}?${qs.toString()}`;
    if (browser.windows && browser.windows.create) {
      browser.windows.create({
        url: url,
        type: 'popup',
        width: 600,
        height: 400
      });
    } else {
      browser.tabs.create({ url: url });
    }

    prompts[id] = { resolve, reject };
  });
}
