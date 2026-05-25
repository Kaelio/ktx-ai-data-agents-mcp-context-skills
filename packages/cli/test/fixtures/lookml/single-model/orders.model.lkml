connection: "my_bq"

include: "views/*.view.lkml"

explore: orders {
  join: customers {
    relationship: many_to_one
    sql_on: ${orders.customer_id} = ${customers.id} ;;
  }
}
