"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const process_1 = __importDefault(require("process"));
const p = __importStar(require("vscode-languageserver-protocol"));
const m = __importStar(require("vscode-jsonrpc/lib/messages"));
const v = __importStar(require("vscode-languageserver"));
const rpc = __importStar(require("vscode-jsonrpc"));
const path = __importStar(require("path"));
const fs_1 = __importDefault(require("fs"));
// TODO: check DidChangeWatchedFilesNotification.
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const utils = __importStar(require("./utils"));
const c = __importStar(require("./constants"));
const chokidar = __importStar(require("chokidar"));
const console_1 = require("console");
const url_1 = require("url");
// https://microsoft.github.io/language-server-protocol/specification#initialize
// According to the spec, there could be requests before the 'initialize' request. Link in comment tells how to handle them.
let initialized = false;
let serverSentRequestIdCounter = 0;
// https://microsoft.github.io/language-server-protocol/specification#exit
let shutdownRequestAlreadyReceived = false;
let stupidFileContentCache = new Map();
let projectsFiles = new Map();
// ^ caching AND states AND distributed system. Why does LSP has to be stupid like this
// This keeps track of code actions extracted from diagnostics.
let codeActionsFromDiagnostics = {};
// will be properly defined later depending on the mode (stdio/node-rpc)
let send = (_) => { };
let createInterfaceRequest = new v.RequestType("rescript-vscode.create_interface");
let openCompiledFileRequest = new v.RequestType("rescript-vscode.open_compiled");
let sendUpdatedDiagnostics = () => {
    projectsFiles.forEach(({ filesWithDiagnostics }, projectRootPath) => {
        let content = fs_1.default.readFileSync(path.join(projectRootPath, c.compilerLogPartialPath), { encoding: "utf-8" });
        let { done, result: filesAndErrors, codeActions, } = utils.parseCompilerLogOutput(content);
        codeActionsFromDiagnostics = codeActions;
        // diff
        Object.keys(filesAndErrors).forEach((file) => {
            let params = {
                uri: file,
                diagnostics: filesAndErrors[file],
            };
            let notification = {
                jsonrpc: c.jsonrpcVersion,
                method: "textDocument/publishDiagnostics",
                params: params,
            };
            send(notification);
            filesWithDiagnostics.add(file);
        });
        if (done) {
            // clear old files
            filesWithDiagnostics.forEach((file) => {
                if (filesAndErrors[file] == null) {
                    // Doesn't exist in the new diagnostics. Clear this diagnostic
                    let params = {
                        uri: file,
                        diagnostics: [],
                    };
                    let notification = {
                        jsonrpc: c.jsonrpcVersion,
                        method: "textDocument/publishDiagnostics",
                        params: params,
                    };
                    send(notification);
                    filesWithDiagnostics.delete(file);
                }
            });
        }
    });
};
let deleteProjectDiagnostics = (projectRootPath) => {
    let root = projectsFiles.get(projectRootPath);
    if (root != null) {
        root.filesWithDiagnostics.forEach((file) => {
            let params = {
                uri: file,
                diagnostics: [],
            };
            let notification = {
                jsonrpc: c.jsonrpcVersion,
                method: "textDocument/publishDiagnostics",
                params: params,
            };
            send(notification);
        });
        projectsFiles.delete(projectRootPath);
    }
};
let sendCompilationFinishedMessage = () => {
    let notification = {
        jsonrpc: c.jsonrpcVersion,
        method: "rescript/compilationFinished",
    };
    send(notification);
};
let compilerLogsWatcher = chokidar
    .watch([], {
    awaitWriteFinish: {
        stabilityThreshold: 1,
    },
})
    .on("all", (_e, changedPath) => {
    sendUpdatedDiagnostics();
    sendCompilationFinishedMessage();
});
let stopWatchingCompilerLog = () => {
    // TODO: cleanup of compilerLogs?
    compilerLogsWatcher.close();
};
let openedFile = (fileUri, fileContent) => {
    let filePath = (0, url_1.fileURLToPath)(fileUri);
    stupidFileContentCache.set(filePath, fileContent);
    let projectRootPath = utils.findProjectRootOfFile(filePath);
    if (projectRootPath != null) {
        if (!projectsFiles.has(projectRootPath)) {
            projectsFiles.set(projectRootPath, {
                openFiles: new Set(),
                filesWithDiagnostics: new Set(),
                bsbWatcherByEditor: null,
            });
            compilerLogsWatcher.add(path.join(projectRootPath, c.compilerLogPartialPath));
        }
        let root = projectsFiles.get(projectRootPath);
        root.openFiles.add(filePath);
        let firstOpenFileOfProject = root.openFiles.size === 1;
        // check if .bsb.lock is still there. If not, start a bsb -w ourselves
        // because otherwise the diagnostics info we'll display might be stale
        let bsbLockPath = path.join(projectRootPath, c.bsbLock);
        if (firstOpenFileOfProject && !fs_1.default.existsSync(bsbLockPath)) {
            // TODO: sometime stale .bsb.lock dangling. bsb -w knows .bsb.lock is
            // stale. Use that logic
            // TODO: close watcher when lang-server shuts down
            if (utils.findNodeBuildOfProjectRoot(projectRootPath) != null) {
                let payload = {
                    title: c.startBuildAction,
                    projectRootPath: projectRootPath,
                };
                let params = {
                    type: p.MessageType.Info,
                    message: `Start a build for this project to get the freshest data?`,
                    actions: [payload],
                };
                let request = {
                    jsonrpc: c.jsonrpcVersion,
                    id: serverSentRequestIdCounter++,
                    method: "window/showMessageRequest",
                    params: params,
                };
                send(request);
                // the client might send us back the "start build" action, which we'll
                // handle in the isResponseMessage check in the message handling way
                // below
            }
            else {
                // we should send something to say that we can't find bsb.exe. But right now we'll silently not do anything
            }
        }
        // no need to call sendUpdatedDiagnostics() here; the watcher add will
        // call the listener which calls it
    }
};
let closedFile = (fileUri) => {
    let filePath = (0, url_1.fileURLToPath)(fileUri);
    stupidFileContentCache.delete(filePath);
    let projectRootPath = utils.findProjectRootOfFile(filePath);
    if (projectRootPath != null) {
        let root = projectsFiles.get(projectRootPath);
        if (root != null) {
            root.openFiles.delete(filePath);
            // clear diagnostics too if no open files open in said project
            if (root.openFiles.size === 0) {
                compilerLogsWatcher.unwatch(path.join(projectRootPath, c.compilerLogPartialPath));
                deleteProjectDiagnostics(projectRootPath);
                if (root.bsbWatcherByEditor !== null) {
                    root.bsbWatcherByEditor.kill();
                    root.bsbWatcherByEditor = null;
                }
            }
        }
    }
};
let updateOpenedFile = (fileUri, fileContent) => {
    let filePath = (0, url_1.fileURLToPath)(fileUri);
    (0, console_1.assert)(stupidFileContentCache.has(filePath));
    stupidFileContentCache.set(filePath, fileContent);
};
let getOpenedFileContent = (fileUri) => {
    let filePath = (0, url_1.fileURLToPath)(fileUri);
    let content = stupidFileContentCache.get(filePath);
    (0, console_1.assert)(content != null);
    return content;
};
// Start listening now!
// We support two modes: the regular node RPC mode for VSCode, and the --stdio
// mode for other editors The latter is _technically unsupported_. It's an
// implementation detail that might change at any time
if (process_1.default.argv.includes("--stdio")) {
    let writer = new rpc.StreamMessageWriter(process_1.default.stdout);
    let reader = new rpc.StreamMessageReader(process_1.default.stdin);
    // proper `this` scope for writer
    send = (msg) => writer.write(msg);
    reader.listen(onMessage);
}
else {
    // proper `this` scope for process
    send = (msg) => process_1.default.send(msg);
    process_1.default.on("message", onMessage);
}
function hover(msg) {
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let code = getOpenedFileContent(params.textDocument.uri);
    let tmpname = utils.createFileInTempDir();
    fs_1.default.writeFileSync(tmpname, code, { encoding: "utf-8" });
    let response = utils.runAnalysisCommand(filePath, [
        "hover",
        filePath,
        params.position.line,
        params.position.character,
        tmpname,
    ], msg);
    fs_1.default.unlink(tmpname, () => null);
    return response;
}
function definition(msg) {
    // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_definition
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let response = utils.runAnalysisCommand(filePath, ["definition", filePath, params.position.line, params.position.character], msg);
    return response;
}
function typeDefinition(msg) {
    // https://microsoft.github.io/language-server-protocol/specification/specification-current/#textDocument_typeDefinition
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let response = utils.runAnalysisCommand(filePath, [
        "typeDefinition",
        filePath,
        params.position.line,
        params.position.character,
    ], msg);
    return response;
}
function references(msg) {
    // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_references
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let result = utils.getReferencesForPosition(filePath, params.position);
    let response = {
        jsonrpc: c.jsonrpcVersion,
        id: msg.id,
        result,
        // error: code and message set in case an exception happens during the definition request.
    };
    return response;
}
function prepareRename(msg) {
    // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_prepareRename
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let locations = utils.getReferencesForPosition(filePath, params.position);
    let result = null;
    if (locations !== null) {
        locations.forEach((loc) => {
            if (path.normalize((0, url_1.fileURLToPath)(loc.uri)) ===
                path.normalize((0, url_1.fileURLToPath)(params.textDocument.uri))) {
                let { start, end } = loc.range;
                let pos = params.position;
                if (start.character <= pos.character &&
                    start.line <= pos.line &&
                    end.character >= pos.character &&
                    end.line >= pos.line) {
                    result = loc.range;
                }
            }
        });
    }
    return {
        jsonrpc: c.jsonrpcVersion,
        id: msg.id,
        result,
    };
}
function rename(msg) {
    // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_rename
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let documentChanges = utils.runAnalysisAfterSanityCheck(filePath, [
        "rename",
        filePath,
        params.position.line,
        params.position.character,
        params.newName,
    ]);
    let result = null;
    if (documentChanges !== null) {
        result = { documentChanges };
    }
    let response = {
        jsonrpc: c.jsonrpcVersion,
        id: msg.id,
        result,
    };
    return response;
}
function documentSymbol(msg) {
    // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_documentSymbol
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let extension = path.extname(params.textDocument.uri);
    let code = getOpenedFileContent(params.textDocument.uri);
    let tmpname = utils.createFileInTempDir(extension);
    fs_1.default.writeFileSync(tmpname, code, { encoding: "utf-8" });
    let response = utils.runAnalysisCommand(filePath, ["documentSymbol", tmpname], msg, 
    /* projectRequired */ false);
    fs_1.default.unlink(tmpname, () => null);
    return response;
}
function semanticTokens(msg) {
    // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_semanticTokens
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let extension = path.extname(params.textDocument.uri);
    let code = getOpenedFileContent(params.textDocument.uri);
    let tmpname = utils.createFileInTempDir(extension);
    fs_1.default.writeFileSync(tmpname, code, { encoding: "utf-8" });
    let response = utils.runAnalysisCommand(filePath, ["semanticTokens", tmpname], msg, 
    /* projectRequired */ false);
    fs_1.default.unlink(tmpname, () => null);
    return response;
}
function completion(msg) {
    // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_completion
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let extension = path.extname(params.textDocument.uri);
    let code = getOpenedFileContent(params.textDocument.uri);
    let tmpname = utils.createFileInTempDir();
    fs_1.default.writeFileSync(tmpname, code, { encoding: "utf-8" });
    let response = utils.runAnalysisCommand(filePath, [
        "completion",
        filePath,
        params.position.line,
        params.position.character,
        tmpname,
    ], msg);
    fs_1.default.unlink(tmpname, () => null);
    return response;
}
function codeAction(msg) {
    var _a;
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let code = getOpenedFileContent(params.textDocument.uri);
    let extension = path.extname(params.textDocument.uri);
    let tmpname = utils.createFileInTempDir(extension);
    // Check local code actions coming from the diagnostics.
    let localResults = [];
    (_a = codeActionsFromDiagnostics[params.textDocument.uri]) === null || _a === void 0 ? void 0 : _a.forEach(({ range, codeAction }) => {
        if (utils.rangeContainsRange(range, params.range)) {
            localResults.push(codeAction);
        }
    });
    fs_1.default.writeFileSync(tmpname, code, { encoding: "utf-8" });
    let response = utils.runAnalysisCommand(filePath, [
        "codeAction",
        filePath,
        params.range.start.line,
        params.range.start.character,
        tmpname,
    ], msg);
    fs_1.default.unlink(tmpname, () => null);
    let { result } = response;
    // We must send `null` when there are no results, empty array isn't enough.
    let codeActions = result != null && Array.isArray(result)
        ? [...localResults, ...result]
        : localResults;
    let res = {
        jsonrpc: c.jsonrpcVersion,
        id: msg.id,
        result: codeActions.length > 0 ? codeActions : null,
    };
    return res;
}
function format(msg) {
    // technically, a formatting failure should reply with the error. Sadly
    // the LSP alert box for these error replies sucks (e.g. doesn't actually
    // display the message). In order to signal the client to display a proper
    // alert box (sometime with actionable buttons), we need to first send
    // back a fake success message (because each request mandates a
    // response), then right away send a server notification to display a
    // nicer alert. Ugh.
    let fakeSuccessResponse = {
        jsonrpc: c.jsonrpcVersion,
        id: msg.id,
        result: [],
    };
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.textDocument.uri);
    let extension = path.extname(params.textDocument.uri);
    if (extension !== c.resExt && extension !== c.resiExt) {
        let params = {
            type: p.MessageType.Error,
            message: `Not a ${c.resExt} or ${c.resiExt} file. Cannot format it.`,
        };
        let response = {
            jsonrpc: c.jsonrpcVersion,
            method: "window/showMessage",
            params: params,
        };
        return [fakeSuccessResponse, response];
    }
    else {
        // code will always be defined here, even though technically it can be undefined
        let code = getOpenedFileContent(params.textDocument.uri);
        let formattedResult = utils.formatCode(filePath, code);
        if (formattedResult.kind === "success") {
            let max = code.length;
            let result = [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: max, character: max },
                    },
                    newText: formattedResult.result,
                },
            ];
            let response = {
                jsonrpc: c.jsonrpcVersion,
                id: msg.id,
                result: result,
            };
            return [response];
        }
        else {
            // let the diagnostics logic display the updated syntax errors,
            // from the build.
            // Again, not sending the actual errors. See fakeSuccessResponse
            // above for explanation
            return [fakeSuccessResponse];
        }
    }
}
function createInterface(msg) {
    let params = msg.params;
    let extension = path.extname(params.uri);
    let filePath = (0, url_1.fileURLToPath)(params.uri);
    let projDir = utils.findProjectRootOfFile(filePath);
    if (projDir === null) {
        let params = {
            type: p.MessageType.Error,
            message: `Cannot locate project directory to generate the interface file.`,
        };
        let response = {
            jsonrpc: c.jsonrpcVersion,
            method: "window/showMessage",
            params: params,
        };
        return response;
    }
    if (extension !== c.resExt) {
        let params = {
            type: p.MessageType.Error,
            message: `Not a ${c.resExt} file. Cannot create an interface for it.`,
        };
        let response = {
            jsonrpc: c.jsonrpcVersion,
            method: "window/showMessage",
            params: params,
        };
        return response;
    }
    let resPartialPath = filePath.split(projDir)[1];
    // The .cmi filename may have a namespace suffix appended.
    let namespaceResult = utils.getNamespaceNameFromBsConfig(projDir);
    if (namespaceResult.kind === "error") {
        let params = {
            type: p.MessageType.Error,
            message: `Error reading bsconfig file.`,
        };
        let response = {
            jsonrpc: c.jsonrpcVersion,
            method: "window/showMessage",
            params,
        };
        return response;
    }
    let namespace = namespaceResult.result;
    let suffixToAppend = namespace.length > 0 ? "-" + namespace : "";
    let cmiPartialPath = path.join(path.dirname(resPartialPath), path.basename(resPartialPath, c.resExt) + suffixToAppend + c.cmiExt);
    let cmiPath = path.join(projDir, c.compilerDirPartialPath, cmiPartialPath);
    let cmiAvailable = fs_1.default.existsSync(cmiPath);
    if (!cmiAvailable) {
        let params = {
            type: p.MessageType.Error,
            message: `No compiled interface file found. Please compile your project first.`,
        };
        let response = {
            jsonrpc: c.jsonrpcVersion,
            method: "window/showMessage",
            params,
        };
        return response;
    }
    let response = utils.runAnalysisCommand(filePath, ["createInterface", filePath, cmiPath], msg);
    let result = typeof response.result === "string" ? response.result : "";
    try {
        let resiPath = utils.replaceFileExtension(filePath, c.resiExt);
        fs_1.default.writeFileSync(resiPath, result, { encoding: "utf-8" });
        let response = {
            jsonrpc: c.jsonrpcVersion,
            id: msg.id,
            result: "Interface successfully created.",
        };
        return response;
    }
    catch (e) {
        let response = {
            jsonrpc: c.jsonrpcVersion,
            id: msg.id,
            error: {
                code: m.ErrorCodes.InternalError,
                message: "Unable to create interface file.",
            },
        };
        return response;
    }
}
function openCompiledFile(msg) {
    let params = msg.params;
    let filePath = (0, url_1.fileURLToPath)(params.uri);
    let projDir = utils.findProjectRootOfFile(filePath);
    if (projDir === null) {
        let params = {
            type: p.MessageType.Error,
            message: `Cannot locate project directory.`,
        };
        let response = {
            jsonrpc: c.jsonrpcVersion,
            method: "window/showMessage",
            params: params,
        };
        return response;
    }
    let compiledFilePath = utils.getCompiledFilePath(filePath, projDir);
    if (compiledFilePath.kind === "error" ||
        !fs_1.default.existsSync(compiledFilePath.result)) {
        let message = compiledFilePath.kind === "success"
            ? `No compiled file found. Expected it at: ${compiledFilePath.result}`
            : `No compiled file found. Please compile your project first.`;
        let params = {
            type: p.MessageType.Error,
            message,
        };
        let response = {
            jsonrpc: c.jsonrpcVersion,
            method: "window/showMessage",
            params,
        };
        return response;
    }
    let result = {
        uri: compiledFilePath.result,
    };
    let response = {
        jsonrpc: c.jsonrpcVersion,
        id: msg.id,
        result,
    };
    return response;
}
function onMessage(msg) {
    if (m.isNotificationMessage(msg)) {
        // notification message, aka the client ends it and doesn't want a reply
        if (!initialized && msg.method !== "exit") {
            // From spec: "Notifications should be dropped, except for the exit notification. This will allow the exit of a server without an initialize request"
            // For us: do nothing. We don't have anything we need to clean up right now
            // TODO: we might have things we need to clean up now... like some watcher stuff
        }
        else if (msg.method === "exit") {
            // The server should exit with success code 0 if the shutdown request has been received before; otherwise with error code 1
            if (shutdownRequestAlreadyReceived) {
                process_1.default.exit(0);
            }
            else {
                process_1.default.exit(1);
            }
        }
        else if (msg.method === vscode_languageserver_protocol_1.DidOpenTextDocumentNotification.method) {
            let params = msg.params;
            let extName = path.extname(params.textDocument.uri);
            openedFile(params.textDocument.uri, params.textDocument.text);
        }
        else if (msg.method === vscode_languageserver_protocol_1.DidChangeTextDocumentNotification.method) {
            let params = msg.params;
            let extName = path.extname(params.textDocument.uri);
            if (extName === c.resExt || extName === c.resiExt) {
                let changes = params.contentChanges;
                if (changes.length === 0) {
                    // no change?
                }
                else {
                    // we currently only support full changes
                    updateOpenedFile(params.textDocument.uri, changes[changes.length - 1].text);
                }
            }
        }
        else if (msg.method === vscode_languageserver_protocol_1.DidCloseTextDocumentNotification.method) {
            let params = msg.params;
            closedFile(params.textDocument.uri);
        }
    }
    else if (m.isRequestMessage(msg)) {
        // request message, aka client sent request and waits for our mandatory reply
        if (!initialized && msg.method !== "initialize") {
            let response = {
                jsonrpc: c.jsonrpcVersion,
                id: msg.id,
                error: {
                    code: m.ErrorCodes.ServerNotInitialized,
                    message: "Server not initialized.",
                },
            };
            send(response);
        }
        else if (msg.method === "initialize") {
            // send the list of features we support
            let result = {
                // This tells the client: "hey, we support the following operations".
                // Example: we want to expose "jump-to-definition".
                // By adding `definitionProvider: true`, the client will now send "jump-to-definition" requests.
                capabilities: {
                    // TODO: incremental sync?
                    textDocumentSync: v.TextDocumentSyncKind.Full,
                    documentFormattingProvider: true,
                    hoverProvider: true,
                    definitionProvider: true,
                    typeDefinitionProvider: true,
                    referencesProvider: true,
                    codeActionProvider: true,
                    renameProvider: { prepareProvider: true },
                    documentSymbolProvider: true,
                    completionProvider: { triggerCharacters: [".", ">", "@", "~", '"'] },
                    semanticTokensProvider: {
                        legend: {
                            tokenTypes: [
                                "operator",
                                "variable",
                                "support-type-primitive",
                                "jsx-tag",
                                "class",
                                "enumMember",
                                "property",
                                "jsx-lowercase",
                            ],
                            tokenModifiers: [],
                        },
                        documentSelector: null,
                        // TODO: Support range for full, and add delta support
                        full: true,
                    },
                },
            };
            let response = {
                jsonrpc: c.jsonrpcVersion,
                id: msg.id,
                result: result,
            };
            initialized = true;
            send(response);
        }
        else if (msg.method === "initialized") {
            // sent from client after initialize. Nothing to do for now
            let response = {
                jsonrpc: c.jsonrpcVersion,
                id: msg.id,
                result: null,
            };
            send(response);
        }
        else if (msg.method === "shutdown") {
            // https://microsoft.github.io/language-server-protocol/specification#shutdown
            if (shutdownRequestAlreadyReceived) {
                let response = {
                    jsonrpc: c.jsonrpcVersion,
                    id: msg.id,
                    error: {
                        code: m.ErrorCodes.InvalidRequest,
                        message: `Language server already received the shutdown request`,
                    },
                };
                send(response);
            }
            else {
                shutdownRequestAlreadyReceived = true;
                // TODO: recheck logic around init/shutdown...
                stopWatchingCompilerLog();
                // TODO: delete bsb watchers
                let response = {
                    jsonrpc: c.jsonrpcVersion,
                    id: msg.id,
                    result: null,
                };
                send(response);
            }
        }
        else if (msg.method === p.HoverRequest.method) {
            send(hover(msg));
        }
        else if (msg.method === p.DefinitionRequest.method) {
            send(definition(msg));
        }
        else if (msg.method === p.TypeDefinitionRequest.method) {
            send(typeDefinition(msg));
        }
        else if (msg.method === p.ReferencesRequest.method) {
            send(references(msg));
        }
        else if (msg.method === p.PrepareRenameRequest.method) {
            send(prepareRename(msg));
        }
        else if (msg.method === p.RenameRequest.method) {
            send(rename(msg));
        }
        else if (msg.method === p.DocumentSymbolRequest.method) {
            send(documentSymbol(msg));
        }
        else if (msg.method === p.CompletionRequest.method) {
            send(completion(msg));
        }
        else if (msg.method === p.SemanticTokensRequest.method) {
            send(semanticTokens(msg));
        }
        else if (msg.method === p.CodeActionRequest.method) {
            send(codeAction(msg));
        }
        else if (msg.method === p.DocumentFormattingRequest.method) {
            let responses = format(msg);
            responses.forEach((response) => send(response));
        }
        else if (msg.method === createInterfaceRequest.method) {
            send(createInterface(msg));
        }
        else if (msg.method === openCompiledFileRequest.method) {
            send(openCompiledFile(msg));
        }
        else {
            let response = {
                jsonrpc: c.jsonrpcVersion,
                id: msg.id,
                error: {
                    code: m.ErrorCodes.InvalidRequest,
                    message: "Unrecognized editor request.",
                },
            };
            send(response);
        }
    }
    else if (m.isResponseMessage(msg)) {
        // response message. Currently the client should have only sent a response
        // for asking us to start the build (see window/showMessageRequest in this
        // file)
        if (msg.result != null &&
            // @ts-ignore
            msg.result.title != null &&
            // @ts-ignore
            msg.result.title === c.startBuildAction) {
            let msg_ = msg.result;
            let projectRootPath = msg_.projectRootPath;
            // TODO: sometime stale .bsb.lock dangling
            // TODO: close watcher when lang-server shuts down. However, by Node's
            // default, these subprocesses are automatically killed when this
            // language-server process exits
            let found = utils.findNodeBuildOfProjectRoot(projectRootPath);
            if (found != null) {
                let bsbProcess = utils.runBuildWatcherUsingValidBuildPath(found.buildPath, found.isReScript, projectRootPath);
                let root = projectsFiles.get(projectRootPath);
                root.bsbWatcherByEditor = bsbProcess;
                // bsbProcess.on("message", (a) => console.log(a));
            }
        }
    }
}
//# sourceMappingURL=server.js.map