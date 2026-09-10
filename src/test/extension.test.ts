import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('loads the extension module', () => {
		assert.ok(require('../extension'));
	});
});
