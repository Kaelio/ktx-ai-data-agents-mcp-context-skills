view: orders {
  extends: [base]
  sql_table_name: public.orders ;;
  dimension: amount {
    type: number
    sql: ${TABLE}.amount ;;
  }
  measure: gross {
    type: sum
    sql: ${amount} ;;
  }
}
