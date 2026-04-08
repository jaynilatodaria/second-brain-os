require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { resetCollections } = require("../backend/services/qdrantSync");

resetCollections()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
