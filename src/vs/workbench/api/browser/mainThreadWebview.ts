/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from 'vs/base/common/errors';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { isWeb } from 'vs/base/common/platform';
import { startsWith } from 'vs/base/common/strings';
import { URI, UriComponents } from 'vs/base/common/uri';
import * as modes from 'vs/editor/common/modes';
import { localize } from 'vs/nls';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IProductService } from 'vs/platform/product/common/product';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ExtHostContext, ExtHostWebviewsShape, IExtHostContext, MainContext, MainThreadWebviewsShape, WebviewPanelHandle, WebviewPanelShowOptions, WebviewPanelViewStateData } from 'vs/workbench/api/common/extHost.protocol';
import { editorGroupToViewColumn, EditorViewColumn, viewColumnToEditorGroup } from 'vs/workbench/api/common/shared/editor';
import { WebviewEditorInput } from 'vs/workbench/contrib/webview/browser/webviewEditorInput';
import { ICreateWebViewShowOptions, IWebviewEditorService, WebviewInputOptions } from 'vs/workbench/contrib/webview/browser/webviewEditorService';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { extHostNamedCustomer } from '../common/extHostCustomers';
import { CustomFileEditorInput } from 'vs/workbench/contrib/customEditor/browser/customEditorInput';

/**
 * Bi-directional map between webview handles and inputs.
 */
class WebviewHandleStore {
	private readonly _handlesToInputs = new Map<string, WebviewEditorInput>();
	private readonly _inputsToHandles = new Map<WebviewEditorInput, string>();

	public add(handle: string, input: WebviewEditorInput): void {
		this._handlesToInputs.set(handle, input);
		this._inputsToHandles.set(input, handle);
	}

	public getHandleForInput(input: WebviewEditorInput): string | undefined {
		return this._inputsToHandles.get(input);
	}

	public getInputForHandle(handle: string): WebviewEditorInput | undefined {
		return this._handlesToInputs.get(handle);
	}

	public delete(handle: string): void {
		const input = this.getInputForHandle(handle);
		this._handlesToInputs.delete(handle);
		if (input) {
			this._inputsToHandles.delete(input);
		}
	}

	public get size(): number {
		return this._handlesToInputs.size;
	}
}

@extHostNamedCustomer(MainContext.MainThreadWebviews)
export class MainThreadWebviews extends Disposable implements MainThreadWebviewsShape {

	private static readonly standardSupportedLinkSchemes = new Set([
		'http',
		'https',
		'mailto',
		'vscode',
		'vscode-insider',
	]);

	private static revivalPool = 0;

	private readonly _proxy: ExtHostWebviewsShape;
	private readonly _webviewEditorInputs = new WebviewHandleStore();
	private readonly _revivers = new Map<string, IDisposable>();
	private readonly _editorProviders = new Map<string, IDisposable>();

	constructor(
		context: IExtHostContext,
		@IExtensionService extensionService: IExtensionService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWebviewEditorService private readonly _webviewEditorService: IWebviewEditorService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();

		this._proxy = context.getProxy(ExtHostContext.ExtHostWebviews);
		this._register(_editorService.onDidActiveEditorChange(this.updateWebviewViewStates, this));
		this._register(_editorService.onDidVisibleEditorsChange(this.updateWebviewViewStates, this));

		// This reviver's only job is to activate webview panel extensions
		// This should trigger the real reviver to be registered from the extension host side.
		this._register(_webviewEditorService.registerResolver({
			canResolve: (webview: WebviewEditorInput) => {
				if (!webview.webview.state && webview.getTypeId() === WebviewEditorInput.typeId) { // TODO: The typeid check is a workaround for the CustomFileEditorInput case
					return false;
				}

				const viewType = this.fromInternalWebviewViewType(webview.viewType);
				if (typeof viewType === 'string') {
					extensionService.activateByEvent(`onWebviewPanel:${viewType}`);
				}
				return false;
			},
			resolveWebview: () => { throw new Error('not implemented'); }
		}));
	}

	public $createWebviewPanel(
		handle: WebviewPanelHandle,
		viewType: string,
		title: string,
		showOptions: { viewColumn?: EditorViewColumn, preserveFocus?: boolean },
		options: WebviewInputOptions,
		extensionId: ExtensionIdentifier,
		extensionLocation: UriComponents
	): void {
		const mainThreadShowOptions: ICreateWebViewShowOptions = Object.create(null);
		if (showOptions) {
			mainThreadShowOptions.preserveFocus = !!showOptions.preserveFocus;
			mainThreadShowOptions.group = viewColumnToEditorGroup(this._editorGroupService, showOptions.viewColumn);
		}

		const webview = this._webviewEditorService.createWebview(handle, this.getInternalWebviewViewType(viewType), title, mainThreadShowOptions, reviveWebviewOptions(options), {
			location: URI.revive(extensionLocation),
			id: extensionId
		});
		this.hookupWebviewEventDelegate(handle, webview);

		this._webviewEditorInputs.add(handle, webview);

		/* __GDPR__
			"webviews:createWebviewPanel" : {
				"extensionId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this._telemetryService.publicLog('webviews:createWebviewPanel', { extensionId: extensionId.value });
	}

	public $disposeWebview(handle: WebviewPanelHandle): void {
		const webview = this.getWebviewEditorInput(handle);
		webview.dispose();
	}

	public $setTitle(handle: WebviewPanelHandle, value: string): void {
		const webview = this.getWebviewEditorInput(handle);
		webview.setName(value);
	}

	public $setState(handle: WebviewPanelHandle, state: modes.WebviewEditorState): void {
		const webview = this.getWebviewEditorInput(handle);
		if (webview instanceof CustomFileEditorInput) {
			webview.setState(state);
		}
	}

	public $setIconPath(handle: WebviewPanelHandle, value: { light: UriComponents, dark: UriComponents } | undefined): void {
		const webview = this.getWebviewEditorInput(handle);
		webview.iconPath = reviveWebviewIcon(value);
	}

	public $setHtml(handle: WebviewPanelHandle, value: string): void {
		const webview = this.getWebviewEditorInput(handle);
		webview.webview.html = value;
	}

	public $setOptions(handle: WebviewPanelHandle, options: modes.IWebviewOptions): void {
		const webview = this.getWebviewEditorInput(handle);
		webview.webview.contentOptions = reviveWebviewOptions(options as any /*todo@mat */);
	}

	public $reveal(handle: WebviewPanelHandle, showOptions: WebviewPanelShowOptions): void {
		const webview = this.getWebviewEditorInput(handle);
		if (webview.isDisposed()) {
			return;
		}

		const targetGroup = this._editorGroupService.getGroup(viewColumnToEditorGroup(this._editorGroupService, showOptions.viewColumn)) || this._editorGroupService.getGroup(webview.group || 0);
		if (targetGroup) {
			this._webviewEditorService.revealWebview(webview, targetGroup, !!showOptions.preserveFocus);
		}
	}

	public async $postMessage(handle: WebviewPanelHandle, message: any): Promise<boolean> {
		const webview = this.getWebviewEditorInput(handle);
		webview.webview.sendMessage(message);
		return true;
	}

	public $registerSerializer(viewType: string): void {
		if (this._revivers.has(viewType)) {
			throw new Error(`Reviver for ${viewType} already registered`);
		}

		this._revivers.set(viewType, this._webviewEditorService.registerResolver({
			canResolve: (webviewEditorInput) => {
				return !!webviewEditorInput.webview.state && webviewEditorInput.viewType === this.getInternalWebviewViewType(viewType);
			},
			resolveWebview: async (webviewEditorInput): Promise<void> => {
				const viewType = this.fromInternalWebviewViewType(webviewEditorInput.viewType);
				if (!viewType) {
					webviewEditorInput.webview.html = MainThreadWebviews.getDeserializationFailedContents(webviewEditorInput.viewType);
					return;
				}

				const handle = `revival-${MainThreadWebviews.revivalPool++}`;
				this._webviewEditorInputs.add(handle, webviewEditorInput);
				this.hookupWebviewEventDelegate(handle, webviewEditorInput);

				let state = undefined;
				if (webviewEditorInput.webview.state) {
					try {
						state = JSON.parse(webviewEditorInput.webview.state);
					} catch {
						// noop
					}
				}

				try {
					await this._proxy.$deserializeWebviewPanel(handle, viewType, webviewEditorInput.getTitle(), state, editorGroupToViewColumn(this._editorGroupService, webviewEditorInput.group || 0), webviewEditorInput.webview.options);
				} catch (error) {
					onUnexpectedError(error);
					webviewEditorInput.webview.html = MainThreadWebviews.getDeserializationFailedContents(viewType);
				}
			}
		}));
	}

	public $unregisterSerializer(viewType: string): void {
		const reviver = this._revivers.get(viewType);
		if (!reviver) {
			throw new Error(`No reviver for ${viewType} registered`);
		}

		reviver.dispose();
		this._revivers.delete(viewType);
	}

	public $registerEditorProvider(viewType: string): void {
		if (this._editorProviders.has(viewType)) {
			throw new Error(`Provider for ${viewType} already registered`);
		}

		this._editorProviders.set(viewType, this._webviewEditorService.registerResolver({
			canResolve: (webviewEditorInput) => {
				return webviewEditorInput.getTypeId() !== WebviewEditorInput.typeId && webviewEditorInput.viewType === viewType;
			},
			resolveWebview: async (webview) => {
				const handle = `resolved-${MainThreadWebviews.revivalPool++}`;
				this._webviewEditorInputs.add(handle, webview);
				this.hookupWebviewEventDelegate(handle, webview);

				try {
					await this._proxy.$resolveWebviewEditor(
						webview.getResource(),
						handle,
						viewType,
						webview.getTitle(),
						webview.webview.state,
						editorGroupToViewColumn(this._editorGroupService, webview.group || 0),
						webview.webview.options
					);
				} catch (error) {
					onUnexpectedError(error);
					webview.webview.html = MainThreadWebviews.getDeserializationFailedContents(viewType);
				}
			}
		}));
	}

	public $unregisterEditorProvider(viewType: string): void {
		const provider = this._editorProviders.get(viewType);
		if (!provider) {
			throw new Error(`No provider for ${viewType} registered`);
		}

		provider.dispose();
		this._editorProviders.delete(viewType);
	}

	private getInternalWebviewViewType(viewType: string): string {
		return `mainThreadWebview-${viewType}`;
	}

	private fromInternalWebviewViewType(viewType: string): string | undefined {
		if (!startsWith(viewType, 'mainThreadWebview-')) {
			return undefined;
		}
		return viewType.replace(/^mainThreadWebview-/, '');
	}

	private hookupWebviewEventDelegate(handle: WebviewPanelHandle, input: WebviewEditorInput) {
		input.webview.onDidClickLink((uri: URI) => this.onDidClickLink(handle, uri));
		input.webview.onMessage((message: any) => this._proxy.$onMessage(handle, message));
		input.onDispose(() => {
			this._proxy.$onDidDisposeWebviewPanel(handle).finally(() => {
				this._webviewEditorInputs.delete(handle);
			});
		});
		input.webview.onDidUpdateState((newState: any) => {
			const webview = this.tryGetWebviewEditorInput(handle);
			if (!webview || webview.isDisposed()) {
				return;
			}
			webview.webview.state = newState;
		});
		input.webview.onMissingCsp((extension: ExtensionIdentifier) => this._proxy.$onMissingCsp(handle, extension.value));
	}

	private updateWebviewViewStates() {
		if (!this._webviewEditorInputs.size) {
			return;
		}

		const activeInput = this._editorService.activeControl && this._editorService.activeControl.input;
		const viewStates: WebviewPanelViewStateData = {};
		for (const group of this._editorGroupService.groups) {
			for (const input of group.editors) {
				if (!(input instanceof WebviewEditorInput)) {
					continue;
				}

				input.updateGroup(group.id);

				const handle = this._webviewEditorInputs.getHandleForInput(input);
				if (handle) {
					viewStates[handle] = {
						visible: input === group.activeEditor,
						active: input === activeInput,
						position: editorGroupToViewColumn(this._editorGroupService, group.id),
					};
				}
			}
		}

		if (Object.keys(viewStates).length) {
			this._proxy.$onDidChangeWebviewPanelViewStates(viewStates);
		}
	}

	private onDidClickLink(handle: WebviewPanelHandle, link: URI): void {
		const webview = this.getWebviewEditorInput(handle);
		if (this.isSupportedLink(webview, link)) {
			this._openerService.open(link);
		}
	}

	private isSupportedLink(webview: WebviewEditorInput, link: URI): boolean {
		if (MainThreadWebviews.standardSupportedLinkSchemes.has(link.scheme)) {
			return true;
		}
		if (!isWeb && this._productService.urlProtocol === link.scheme) {
			return true;
		}
		return !!webview.webview.contentOptions.enableCommandUris && link.scheme === 'command';
	}

	private getWebviewEditorInput(handle: WebviewPanelHandle): WebviewEditorInput {
		const webview = this.tryGetWebviewEditorInput(handle);
		if (!webview) {
			throw new Error('Unknown webview handle:' + handle);
		}
		return webview;
	}

	private tryGetWebviewEditorInput(handle: WebviewPanelHandle): WebviewEditorInput | undefined {
		return this._webviewEditorInputs.getInputForHandle(handle);
	}

	private static getDeserializationFailedContents(viewType: string) {
		return `<!DOCTYPE html>
		<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
			</head>
			<body>${localize('errorMessage', "An error occurred while restoring view:{0}", viewType)}</body>
		</html>`;
	}
}

function reviveWebviewOptions(options: modes.IWebviewOptions): WebviewInputOptions {
	return {
		...options,
		allowScripts: options.enableScripts,
		localResourceRoots: Array.isArray(options.localResourceRoots) ? options.localResourceRoots.map(r => URI.revive(r)) : undefined,
	};
}


function reviveWebviewIcon(
	value: { light: UriComponents, dark: UriComponents } | undefined
): { light: URI, dark: URI } | undefined {
	if (!value) {
		return undefined;
	}

	return {
		light: URI.revive(value.light),
		dark: URI.revive(value.dark)
	};
}
