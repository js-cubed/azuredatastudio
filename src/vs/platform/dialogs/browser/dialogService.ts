/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { IDialogService, IDialogOptions, IConfirmation, IConfirmationResult, DialogType, IShowResult } from 'vs/platform/dialogs/common/dialogs';
import { ILayoutService } from 'vs/platform/layout/browser/layoutService';
import { ILogService } from 'vs/platform/log/common/log';
import Severity from 'vs/base/common/severity';
import { Dialog } from 'vs/base/browser/ui/dialog/dialog';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { attachDialogStyler } from 'vs/platform/theme/common/styler';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { EventHelper } from 'vs/base/browser/dom';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';

export class DialogService implements IDialogService {
	_serviceBrand: undefined;

	private allowableCommands = ['copy', 'cut'];

	constructor(
		@ILogService private readonly logService: ILogService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IThemeService private readonly themeService: IThemeService,
		@IKeybindingService private readonly keybindingService: IKeybindingService
	) { }

	async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
		this.logService.trace('DialogService#confirm', confirmation.message);

		const buttons: string[] = [];
		if (confirmation.primaryButton) {
			buttons.push(confirmation.primaryButton);
		} else {
			buttons.push(nls.localize({ key: 'yesButton', comment: ['&& denotes a mnemonic'] }, "&&Yes"));
		}

		if (confirmation.secondaryButton) {
			buttons.push(confirmation.secondaryButton);
		} else if (typeof confirmation.secondaryButton === 'undefined') {
			buttons.push(nls.localize('cancelButton', "Cancel"));
		}

		const dialogDisposables = new DisposableStore();
		const dialog = new Dialog(
			this.layoutService.container,
			confirmation.message,
			buttons,
			{
				detail: confirmation.detail,
				cancelId: 1,
				type: confirmation.type,
				keyEventProcessor: (event: StandardKeyboardEvent) => {
					const resolved = this.keybindingService.softDispatch(event, this.layoutService.container);
					if (resolved && resolved.commandId) {
						if (this.allowableCommands.indexOf(resolved.commandId) === -1) {
							EventHelper.stop(event, true);
						}
					}
				},
				checkboxChecked: confirmation.checkbox ? confirmation.checkbox.checked : undefined,
				checkboxLabel: confirmation.checkbox ? confirmation.checkbox.label : undefined
			});

		dialogDisposables.add(dialog);
		dialogDisposables.add(attachDialogStyler(dialog, this.themeService));

		const result = await dialog.show();
		dialogDisposables.dispose();

		return { confirmed: result.button === 0, checkboxChecked: result.checkboxChecked };
	}

	private getDialogType(severity: Severity): DialogType {
		return (severity === Severity.Info) ? 'question' : (severity === Severity.Error) ? 'error' : (severity === Severity.Warning) ? 'warning' : 'none';
	}

	async show(severity: Severity, message: string, buttons: string[], options?: IDialogOptions): Promise<IShowResult> {
		this.logService.trace('DialogService#show', message);

		const dialogDisposables = new DisposableStore();
		const dialog = new Dialog(
			this.layoutService.container,
			message,
			buttons,
			{
				detail: options ? options.detail : undefined,
				cancelId: options ? options.cancelId : undefined,
				type: this.getDialogType(severity),
				keyEventProcessor: (event: StandardKeyboardEvent) => {
					const resolved = this.keybindingService.softDispatch(event, this.layoutService.container);
					if (resolved && resolved.commandId) {
						if (this.allowableCommands.indexOf(resolved.commandId) === -1) {
							EventHelper.stop(event, true);
						}
					}
				},
				checkboxLabel: options && options.checkbox ? options.checkbox.label : undefined,
				checkboxChecked: options && options.checkbox ? options.checkbox.checked : undefined
			});

		dialogDisposables.add(dialog);
		dialogDisposables.add(attachDialogStyler(dialog, this.themeService));

		const result = await dialog.show();
		dialogDisposables.dispose();

		return {
			choice: result.button,
			checkboxChecked: result.checkboxChecked
		};
	}
}
