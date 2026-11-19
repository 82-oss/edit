// Files the server carries as text (`import x from "./file.py" with { type: "text" }`).
declare module "*.py" {
  const text: string;
  export default text;
}
