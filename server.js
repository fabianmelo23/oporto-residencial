require('dotenv').config();
const app = require('./src/app');
const { startAutoGuardShiftScheduler } = require('./src/autoGuardShifts');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Oporto Residencial escuchando en puerto ${PORT}`);
  startAutoGuardShiftScheduler();
});
