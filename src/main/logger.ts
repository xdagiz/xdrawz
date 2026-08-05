import { app } from "electron";
import log from "electron-log/main";

const maxSize = 10 * 1024 * 1024;

export const initLogger = () => {
  log.initialize({ spyRendererConsole: true });
  log.transports.console.level = app.isPackaged ? false : "debug";
  log.transports.file.level = app.isPackaged ? "info" : false;

  if (app.isPackaged) log.transports.file.maxSize = maxSize;

  log.errorHandler.startCatching({ showDialog: false });
  log.eventLogger.startLogging({ level: "warn", scope: "event" });

  log.info("main logger ready");
};

export { log };
