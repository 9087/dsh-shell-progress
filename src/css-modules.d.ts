/** CSS Modules: the bundler compiles `x.module.css` into a hashed class map. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
