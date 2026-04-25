module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleNameMapper: {
        '^vscode$': '<rootDir>/src/__tests__/__mocks__/vscode.ts',
    },
};
