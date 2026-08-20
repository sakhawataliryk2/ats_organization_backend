const express = require("express");
const PacketController = require("../controllers/packetController");

module.exports = (pool, authMiddleware) => {
  const router = express.Router();
  const controller = new PacketController(pool);

  // optional auth (recommended)
  router.use(authMiddleware.verifyToken);

  router.get("/", controller.list);
  router.get("/:id", controller.getOne);
  router.post("/", controller.create);
  router.put("/:id", controller.update);
  router.delete("/:id", controller.remove);

  return router;
};
