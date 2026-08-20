const express = require('express');

function createRecordNumberRouter(recordNumberController, authMiddleware) {
    const router = express.Router({ mergeParams: true });
    const { verifyToken } = authMiddleware || {};

    if (verifyToken) {
        router.use(verifyToken);
    }

    // GET /api/record-number/:module/:id -> { recordNumber }
    router.get('/:module/:id', recordNumberController.getRecordNumber);

    return router;
}

module.exports = createRecordNumberRouter;
