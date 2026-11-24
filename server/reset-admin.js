"use strict";
/* Emergency password reset for a super admin. Run with the server STOPPED:
     npm run reset-admin                      -> new random password for the default super admin
     npm run reset-admin -- LOGIN             -> same for LOGIN (created if it does not exist)
     npm run reset-admin -- LOGIN NEWPASSWORD -> choose the password yourself */
const crypto = require("crypto");
const cfg = require("./env");
const store = require("./store");
const auth = require("./auth");
const svc = require("./service");

(async () => {
  const login = auth.normLogin(process.argv[2] || cfg.SUPERADMIN_LOGIN);
  const given = process.argv[3];
  const pw = given || crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "x") + "7a";
  try {
    auth.checkPwRules(pw);
    let u = auth.findByLogin(login);
    if (u) {
      await auth.setPassword(u, pw);
      u.role = "superadmin"; u.blocked = false; u.mustChange = !given;
    } else {
      u = await auth.createUser({ name: cfg.SUPERADMIN_NAME, login, password: pw, role: "superadmin", mustChange: !given });
    }
    svc.audit({ name: "reset-admin (konsol)" }, "user.password", u.login, "console reset");
    store.flushSync();
    console.log("\nГотово. Войдите на /login.html:\n  login:  " + u.login + "\n  parol:  " + pw + (given ? "" : "\n  (случайный пароль; после входа смените его)") + "\n");
    console.log("Если сервер был запущен — перезапустите его (npm start), иначе он перезапишет изменения.");
    process.exit(0);
  } catch (e) {
    console.error("Ошибка: " + (e && e.message || e));
    process.exit(1);
  }
})();
