module.exports = {
    apps: [
        {
            name: 'silent-pay-indexer',
            script: 'dist/main.js',
            cwd: __dirname,
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'dev',
            },
        },
    ],
};
