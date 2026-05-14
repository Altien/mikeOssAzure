import "dotenv/config";
import { buildApp } from "./app";

const PORT = process.env.PORT ?? 3001;

buildApp().listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});
