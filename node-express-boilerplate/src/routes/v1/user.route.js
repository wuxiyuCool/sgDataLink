const express = require('express');
const validate = require('../../middlewares/validate');
const userValidation = require('../../validations/user.validation');
const userController = require('../../controllers/user.controller');
const auth = require('../../middlewares/auth');

/**
 * 用户管理路由（docs/API.md 1.11）：整组要求 JWT + admin（auth('manageUsers')），
 * 普通用户访问一律 403；业务底线（不许删/禁自己、保留最后 admin）在 account.service。
 */
const router = express.Router();

router
  .route('/')
  .get(auth('getUsers'), validate(userValidation.listUsers), userController.getUsers)
  .post(auth('manageUsers'), validate(userValidation.createUser), userController.createUser);

router
  .route('/:id')
  .put(auth('manageUsers'), validate(userValidation.updateUser), userController.updateUser)
  .delete(auth('manageUsers'), validate(userValidation.deleteUser), userController.deleteUser);

router.post(
  '/:id/reset-password',
  auth('manageUsers'),
  validate(userValidation.resetPassword),
  userController.resetPassword,
);

module.exports = router;
