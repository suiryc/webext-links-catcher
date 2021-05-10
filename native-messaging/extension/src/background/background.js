'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { waitForSettings, settings } from '../common/settings.js';
import { WebExtension, NativeApplication } from '../common/messaging.js';
import { ContentScriptHandler } from './content-scripts.js';
import { dlMngr, RequestsHandler } from './downloads.js';
import { MenuHandler } from './menus.js';
import { VideoSourceHandler } from './video-sources.js';
import { TabSuccessor } from './tab-successor.js';
import { TabsHandler } from './tabs.js';


console.log('Starting %s version %s', constants.EXTENSION_ID, browser.runtime.getManifest().version);

// Messages handlers

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg.kind || '') {
    case constants.KIND_CHECK_NATIVE_APP:
      return ext_checkNativeApp(msg);
      break;

    case constants.KIND_TW_CHECK_CONCURRENT:
      return tw_checkConcurrent(msg);
      break;

    case constants.KIND_TW_SAVE:
      // Protection: we really do expect this message to come from a tab.
      if (!sender.tab) return unhandledMessage(msg, sender);
      return tw_save(msg);
      break;

    case constants.KIND_DL_IGNORE_NEXT:
      return dl_ignoreNext(msg);
      break;

    case constants.KIND_DOWNLOAD:
      return dl_download(msg);
      break;

    case constants.KIND_GET_DL_VIDEOS:
      return dl_getVideos(msg);
      break;

    case constants.KIND_CLEAR_MESSAGES:
      return ext_clearMessages(msg);
      break;

    case constants.KIND_GET_EXT_MESSAGES:
      return ext_getMessages(msg);
      break;

    case constants.KIND_ADD_VIDEO_SOURCE:
      // We may receive messages from scripts injected before disabling video
      // interception.
      if (!settings.interceptVideo) return;
      return dl_addVideoSource(msg, sender);
      break;

    case constants.KIND_NOTIFICATION:
      return notification(msg.details || {}, sender);
      break;

    default:
      return unhandledMessage(msg, sender);
      break;
  }
}

// Handles messages received from native application.
function onNativeMessage(app, msg) {
  switch (msg.kind || '') {
    case constants.KIND_CONSOLE:
      return app_console(app, msg);
      break;

    case constants.KIND_NOTIFICATION:
      return notification(msg.details || {}, app);
      break;

    default:
      return unhandledNativeMessage(app, msg);
      break;
  }
}


// Extension message handling

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
  return {
    error: 'Message is not handled by background script',
    message: msg
  };
}

// Checks whether native application is ok.
function ext_checkNativeApp(msg) {
  return nativeApp.postRequest({});
}

// Checks whether TiddlyWiki file (URL) is open in more than one tab/window.
function tw_checkConcurrent(msg) {
  // Get tabs with the target URL, and trigger warning if there are more than one.
  browser.tabs.query({url: msg.url}).then(tabs => {
    if (tabs.length > 1) {
      for (var tab of tabs) {
        // We cannot send a message to a discarded tab.
        if (tab.discarded) continue;
        webext.sendTabMessage(tab.id, {
          kind: constants.KIND_TW_WARN_CONCURRENT
        });
      }
    }
  });
}

// Saves TiddlyWiki document.
function tw_save(msg) {
  // Request native application to do the saving, as WebExtensions have no right to properly do it.
  return nativeApp.postRequest(msg, constants.TW_SAVE_TIMEOUT);
}

// Ignore next download interception.
function dl_ignoreNext(msg) {
  requestsHandler.ignoreNext(msg.ttl);
}

// Triggers download.
function dl_download(msg) {
  return dlMngr.download(msg.details, msg.params);
}

// Gets videos found in currently focused tab.
function dl_getVideos(msg) {
  return videoSourceHandler.getSources();
}

// Clears extension messages.
function ext_clearMessages(msg) {
  var windowId = msg.windowId;
  if (!windowId) {
    applicationMessages = [];
  } else {
    applicationMessages = applicationMessages.filter(details => {
      if (details.windowId != windowId) return true;
      var matchTab = details.tabId == msg.tabId;
      return msg.otherTabs ? matchTab : !matchTab;
    });
  }
  updateStatus();
}

// Gets extension messages to display.
function ext_getMessages(msg) {
  var focusedTab = tabsHandler.focusedTab;
  return {
    focusedWindowId: focusedTab.windowId,
    focusedTabId: focusedTab.id,
    messages: applicationMessages
  };
}

function dl_addVideoSource(msg, sender) {
  msg = Object.assign({}, msg);
  msg.url = msg.src;
  delete(msg.correlationId);
  delete(msg.target);
  delete(msg.kind);
  delete(msg.src);
  return videoSourceHandler.addSource(Object.assign({
    tabId: sender.tab.id,
    frameId: sender.frameId
  }, msg));
}


// Native application message handling

// Logs unhandled messages received.
function unhandledNativeMessage(app, msg) {
  console.warn('Received unhandled native application %s message %o', app.appId, msg);
}

// Logs native application log message.
function app_console(app, msg) {
  if (msg.error) {
    // Application actually failed to properly send the log message.
    console.error(`[${app.appId}] Log failure: ${msg.error}`);
    return;
  }

  var level = msg.level || 'info';
  if (!(level in console)) level = 'info';
  var args = ('args' in msg) ? msg.args : [ msg.content ];
  // Prepend the native application id to distinguish its logs from the
  // webextension ones.
  // If first argument is a string, assume it can be a format, and thus prepend
  // to the string itself. Otherwise prepend to the arguments array.
  if (typeof(args[0]) == 'string') args[0] = `[${app.appId}] ${args[0]}`;
  else args.unshift(`[${app.appId}]`);
  console[level].apply(console, args);
}

function notification(details, sender) {
  if (sender) {
    if (!details.source && sender.appId) {
      details.source = sender.appId;
    }
    if (sender.tab) {
      details.windowId = sender.tab.windowId;
      details.tabId = sender.tab.id;
      details.frameId = sender.frameId;
    }
  }

  util.notification(details);
  addExtensionMessage(details);
}

function addExtensionMessage(details) {
  webext.sendMessage({
    target: constants.TARGET_BROWSER_ACTION,
    kind: constants.KIND_EXT_MESSAGE,
    details: details
  });
  applicationMessages.push(details);

  updateStatus(details.windowId);
}

function updateStatus(windowId) {
  // Update the requested window, or update all known windows.
  var obj = {};
  if (windowId) {
    obj[windowId] = videosSources[windowId] || [];
  } else {
    obj = videosSources;
  }
  for (var [windowId, sources] of Object.entries(obj)) {
    // Reminder: object keys are strings, we need windowId as an integer.
    windowId = Number(windowId);
    var hasVideos = sources.length;
    if (!hasVideos) hasVideos = '';

    // Messages are kept until dismissed, and we set a visual hint.
    // Note: 0 and '' are both considered false.
    var hasMessages = '';
    var badgeBackgroundColor = 'blue';
    var tabHandler = tabsHandler.getActiveTab(windowId);
    var tabId = tabHandler ? tabHandler.id : -1;
    for (var details of applicationMessages) {
      if (details.windowId && (details.windowId != windowId)) continue;
      if (details.tabId && (details.tabId != tabId)) continue;
      if (details.level == 'error') {
        hasMessages = '!';
        badgeBackgroundColor = 'red';
      } else if (!hasMessages) {
        hasMessages = 'i';
        badgeBackgroundColor = 'yellow';
      }
    }

    if (!hasMessages && !hasVideos) {
      browser.browserAction.setBadgeText({windowId: windowId, text: null});
      browser.browserAction.setBadgeBackgroundColor({windowId: windowId, color: null});
      continue;
    }

    browser.browserAction.setBadgeText({windowId: windowId, text: `${hasVideos}${hasMessages}`});
    browser.browserAction.setBadgeBackgroundColor({windowId: windowId, color: badgeBackgroundColor});
  }
}

class TabsObserver {

  constructor(tabsHandler, videoSourceHandler) {
    this.tabsHandler = tabsHandler;
    this.videoSourceHandler = videoSourceHandler;
    videoSourceHandler.observer = this;
    tabsHandler.addObserver(this);
  }

  windowRemoved(windowId) {
    delete(videosSources[windowId]);
    applicationMessages = applicationMessages.filter(msg => msg.windowId !== windowId);
  }

  tabActivated(details) {
    var sources = details.tabHandler ? this.videoSourceHandler.getSources(details.tabHandler) : [];
    this.updateVideos(details.windowId, sources);
  }

  tabRemoved(details) {
    applicationMessages = applicationMessages.filter(msg => msg.tabId !== details.tabId);
  }

  videosUpdated(details) {
    var tabHandler = details.tabHandler;
    if (!tabHandler.isActive()) return;
    var sources = this.videoSourceHandler.getSources(tabHandler, details.sources);
    this.updateVideos(tabHandler.windowId, sources);
  }

  updateVideos(windowId, sources) {
    videosSources[windowId] = sources;
    // Only the focused window browser page could be listening (and thus
    // running): no need to notify it of sources for other windows.
    if (this.tabsHandler.focusedWindowId == windowId) {
      webext.sendMessage({
        target: constants.TARGET_BROWSER_ACTION,
        kind: constants.KIND_DL_UPDATE_VIDEOS,
        sources: sources
      });
    }
    updateStatus(windowId);
  }

}


var webext;
var requestsHandler;
var tabsHandler;
var videoSourceHandler;
var nativeApp;
var applicationMessages = [];
var videosSources = {};
waitForSettings(true).then(() => {
  // Handle tabs.
  tabsHandler = new TabsHandler();
  // Extension handler
  webext = new WebExtension({
    target: constants.TARGET_BACKGROUND_PAGE,
    onMessage: onMessage,
    tabsHandler: tabsHandler
  });
  // Native application handler
  nativeApp = new NativeApplication(constants.APPLICATION_ID, { onMessage: onNativeMessage });

  // Start native application and request its specs
  nativeApp.connect();
  console.info('Native application %s starting', nativeApp.appId);
  nativeApp.postRequest({
    kind: constants.KIND_SPECS
  }).then(specs => {
    console.log('Native application %s started: %o', nativeApp.appId, specs);
  }).catch(err => {
    console.log('Native application %s failed to start: %o', nativeApp.appId, err);
  });


  // Listen to requests and downloads.
  dlMngr.setup(webext, nativeApp);
  requestsHandler = new RequestsHandler(webext);
  // Handle menus.
  var menuHandler = new MenuHandler(requestsHandler);
  // Handle tab successor (tab closing).
  new TabSuccessor(tabsHandler);
  // Handle content script injection.
  new ContentScriptHandler(tabsHandler);
  // Handle video sources.
  videoSourceHandler = new VideoSourceHandler(webext, tabsHandler, menuHandler);
  new TabsObserver(tabsHandler, videoSourceHandler);
});
