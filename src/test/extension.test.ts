import * as assert from 'assert';
import * as vscode from 'vscode';
import { toPositiveLineNumber } from '../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('normalizes a command argument to a positive line number', () => {
		assert.strictEqual(toPositiveLineNumber(3.9), 3);
		assert.strictEqual(toPositiveLineNumber(-12), 12);
		assert.strictEqual(toPositiveLineNumber(0), 1);
		assert.strictEqual(toPositiveLineNumber('not a line'), undefined);
	});
});